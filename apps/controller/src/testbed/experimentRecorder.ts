import type { GatewaySliceStats } from '@/telemetry/adapters/gateway.telemetry.adapter';

/**
 * EXPERIMENT CSV
 * ==============
 * One row per slice per gateway measurement window (2 s), taken straight from the gateway's
 * measurements — the numbers the paper reports. Used by the dashboard's experiment recorder and
 * by `npm run demo:local`, so both files have the same columns and meaning.
 *
 * Unknown values stay BLANK, never 0: a slice with no answered probe has unknown latency, not
 * 0 ms latency, and unknown availability, not 0 % availability.
 */

export const EXPERIMENT_CSV_HEADER =
  't_ms,scenario,arbitration_on,slice,demand_kbps,limit_kbps,used_kbps,dropped_kbps,queue_ms,' +
  'latency_p50_ms,latency_p95_ms,jitter_ms,loss_pct,availability_pct,devices,contention_state,decision_id';

export interface ExperimentRowContext {
  /** Milliseconds since the experiment started. */
  tMs: number;
  scenario: string;
  arbitrationOn: boolean;
  /** Status of the open contention event, or NONE. */
  contentionState: string;
  /** Most recent decision for the open contention, if any. */
  decisionId: string;
}

const cell = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(value) ? '' : String(value);

export function experimentRows(
  stats: readonly GatewaySliceStats[],
  context: ExperimentRowContext,
): string[] {
  return stats.map((s) =>
    [
      context.tMs,
      context.scenario,
      context.arbitrationOn,
      s.code,
      s.demandKbps,
      s.limitKbps,
      s.usedKbps,
      s.droppedKbps,
      s.queueMs,
      cell(s.latencyP50Ms),
      cell(s.latencyP95Ms),
      cell(s.jitterMs),
      s.lossPct,
      cell(s.availabilityPct),
      s.activeDevices,
      context.contentionState,
      context.decisionId,
    ].join(','),
  );
}

/**
 * Records one row set per gateway window: polls faster than the window and writes only when the
 * gateway has closed a new one, so no window is duplicated or skipped.
 */
export class ExperimentRecorder {
  private lastWindowAtMs = 0;
  private readonly startedAtMs = Date.now();
  private headerWritten = false;

  /** Nothing is written until the first window arrives, so a run with no gateway leaves no file. */
  constructor(
    private readonly readStats: () => Promise<GatewaySliceStats[]>,
    private readonly context: () => Omit<ExperimentRowContext, 'tMs'>,
    private readonly write: (line: string) => void,
  ) {}

  async poll(): Promise<number> {
    const stats = await this.readStats();
    const windowAt = Math.max(0, ...stats.map((s) => s.atMs));
    if (stats.length === 0 || windowAt <= this.lastWindowAtMs) return 0;
    this.lastWindowAtMs = windowAt;

    if (!this.headerWritten) {
      this.write(`${EXPERIMENT_CSV_HEADER}\n`);
      this.headerWritten = true;
    }
    const rows = experimentRows(stats, { ...this.context(), tMs: windowAt - this.startedAtMs });
    for (const row of rows) this.write(`${row}\n`);
    return rows.length;
  }
}
