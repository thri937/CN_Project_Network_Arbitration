import { OFFERED_CAPACITY_MBPS, env } from '@/config/env';
import { Collections } from '@/constants/collections';
import { HealthState, SliceStatus } from '@/constants/enums';
import { CapacityTunables } from '@/constants/tunables';
import type { IClock } from '@/interfaces/clock.port';
import type { IDatastore, IRepository } from '@/interfaces/repository.port';
import { CapacityLevel, type CapacitySnapshot, type CapacityState } from '@/models/capacity.model';
import type { NetworkSnapshot } from '@/models/telemetry.model';
import { clamp, linearTrend, round, safeDivide } from '@/utils/math';
import { createLogger } from '@/utils/logger';

const log = createLogger('capacity-monitor');

/**
 * Capacity monitor.
 *
 * Folds each telemetry snapshot into a network-wide view: how much capacity exists, how
 * much is committed, how much is actually flowing, and — the number that matters — how
 * much is being ASKED FOR.
 *
 * THREE RATIOS, AND WHY THE DISTINCTION IS LOAD-BEARING
 * =====================================================
 *   utilisation     used / offered       — always ≤ 1. What is flowing.
 *   allocationRatio allocated / offered  — can exceed 1. What has been promised.
 *   demandRatio     demand / offered     — can exceed 1. What is being asked for.
 *
 * A conventional monitor tracks only utilisation, and utilisation is USELESS for detecting
 * contention: it saturates at 1.0 and stays there whether the network is 3 % oversubscribed
 * or 300 %. Every slice reports "100 % utilised" and the dashboard looks identically red in
 * both cases.
 *
 * Demand is unbounded and is therefore the only signal that says how bad it is — and the
 * only one from which a meaningful severity, and a meaningful target reduction, can be
 * computed. This is the measurement the contention detector and the arbitration engine both
 * key off.
 */
export class CapacityService {
  private state: CapacityState | null = null;
  /** Rolling utilisation history for trend and forecast. */
  private readonly history: number[] = [];
  private persistCounter = 0;
  private readonly repo: IRepository<CapacitySnapshot>;

  constructor(
    datastore: IDatastore,
    private readonly clock: IClock,
  ) {
    this.repo = datastore.repository<CapacitySnapshot>(Collections.CAPACITY);
  }

  /**
   * Recompute from a telemetry snapshot.
   *
   * Synchronous and pure apart from the history buffer, so the contention detector can
   * consume the result in the same tick without an await and without any risk of acting on
   * a different snapshot than the one the monitor just measured.
   */
  ingest(snapshot: NetworkSnapshot): CapacityState {
    const offered = snapshot.offeredCapacityMbps || OFFERED_CAPACITY_MBPS;

    const allocated = snapshot.totalAllocatedMbps;
    const used = snapshot.totalUsedMbps;
    const demand = snapshot.totalDemandMbps;

    const utilisation = round(safeDivide(used, offered, 0), 5);
    const demandRatio = round(safeDivide(demand, offered, 0), 5);
    const allocationRatio = round(safeDivide(allocated, offered, 0), 5);

    this.history.push(utilisation);
    if (this.history.length > CapacityTunables.TREND_WINDOW_SAMPLES) this.history.shift();

    const trend = round(linearTrend(this.history), 6);
    // Only forecast once the window is at least half full; a slope fitted to three points
    // is noise, and a confidently wrong forecast on a NOC wall is worse than none.
    const projected =
      this.history.length >= Math.ceil(CapacityTunables.TREND_WINDOW_SAMPLES / 2)
        ? round(clamp(utilisation + trend * CapacityTunables.TREND_WINDOW_SAMPLES, 0, 5), 5)
        : null;

    const degraded = snapshot.slices.filter((s) => s.status === SliceStatus.DEGRADED).length;
    const breaching = snapshot.slices.filter(
      (s) => s.breaches.length > 0 || s.health === HealthState.CRITICAL,
    ).length;

    const excess = Math.max(0, demand - offered);

    this.state = {
      atMs: snapshot.atMs,
      at: snapshot.at,
      totalCapacityMbps: env.NETWORK_TOTAL_CAPACITY_MBPS,
      reservedCapacityMbps: env.NETWORK_RESERVED_CAPACITY_MBPS,
      offeredCapacityMbps: offered,
      allocatedMbps: round(allocated, 3),
      usedMbps: round(used, 3),
      demandMbps: round(demand, 3),
      availableMbps: round(offered - allocated, 3),
      utilisation,
      demandRatio,
      allocationRatio,
      level: classify(demandRatio, utilisation),
      utilisationTrend: trend,
      projectedUtilisation: projected,
      activeSliceCount: snapshot.slices.length,
      degradedSliceCount: degraded,
      breachingSliceCount: breaching,
      oversubscribed: demand > offered,
      excessDemandMbps: round(excess, 3),
    };

    return this.state;
  }

  /**
   * Persist a throttled capacity snapshot.
   *
   * Separate from `ingest` and awaited by the caller, so a slow datastore delays storage
   * but never the control loop that depends on `ingest`'s result.
   */
  async persistIfDue(): Promise<void> {
    if (!this.state || !env.TELEMETRY_PERSIST) return;

    this.persistCounter += 1;
    if (this.persistCounter < env.TELEMETRY_PERSIST_EVERY_N_TICKS) return;
    this.persistCounter = 0;

    const state = this.state;
    try {
      await this.repo.create({
        at: state.at,
        atMs: state.atMs,
        totalCapacityMbps: state.totalCapacityMbps,
        reservedCapacityMbps: state.reservedCapacityMbps,
        offeredCapacityMbps: state.offeredCapacityMbps,
        allocatedMbps: state.allocatedMbps,
        usedMbps: state.usedMbps,
        demandMbps: state.demandMbps,
        availableMbps: state.availableMbps,
        utilisation: state.utilisation,
        demandRatio: state.demandRatio,
        allocationRatio: state.allocationRatio,
        level: state.level,
        utilisationTrend: state.utilisationTrend,
        projectedUtilisation: state.projectedUtilisation,
        activeSliceCount: state.activeSliceCount,
        degradedSliceCount: state.degradedSliceCount,
        breachingSliceCount: state.breachingSliceCount,
      });
    } catch (error) {
      log.error({ err: error }, 'capacity snapshot persistence failed');
    }
  }

  getState(): CapacityState | null {
    return this.state;
  }

  /** Historical capacity series for the Analytics page. */
  async series(fromMs: number, toMs: number, limit = 500): Promise<CapacitySnapshot[]> {
    return this.repo.findMany({
      filters: [
        { field: 'atMs', op: '>=', value: fromMs },
        { field: 'atMs', op: '<=', value: toMs },
      ],
      orderBy: [{ field: 'atMs', direction: 'asc' }],
      limit,
    });
  }

  async pruneOlderThan(cutoffMs: number): Promise<number> {
    return this.repo.deleteMany([{ field: 'atMs', op: '<', value: cutoffMs }]);
  }

  clear(): void {
    this.state = null;
    this.history.length = 0;
    this.persistCounter = 0;
  }

  healthProbe = (): { status: 'up' | 'degraded'; message?: string; details?: Record<string, unknown> } => {
    if (!this.state) return { status: 'degraded', message: 'no capacity measurement yet' };

    return {
      status: 'up',
      details: {
        level: this.state.level,
        utilisation: this.state.utilisation,
        demandRatio: this.state.demandRatio,
        oversubscribed: this.state.oversubscribed,
        availableMbps: this.state.availableMbps,
      },
    };
  };
}

/**
 * Classify network pressure.
 *
 * Demand takes precedence over utilisation: a network at 100 % utilisation with demand at
 * 101 % of capacity is merely full, while the same utilisation with demand at 180 % is in
 * serious trouble. Reporting both as "CRITICAL" would tell an operator nothing.
 */
function classify(demandRatio: number, utilisation: number): CapacityLevel {
  if (demandRatio > 1) return CapacityLevel.OVERSUBSCRIBED;
  if (utilisation >= CapacityTunables.CRITICAL_UTILISATION) return CapacityLevel.CRITICAL;
  if (utilisation >= CapacityTunables.WARNING_UTILISATION) return CapacityLevel.WARNING;
  if (utilisation >= 0.7) return CapacityLevel.ELEVATED;
  return CapacityLevel.HEALTHY;
}
