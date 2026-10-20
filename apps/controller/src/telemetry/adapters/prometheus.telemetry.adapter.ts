import { HealthState } from '@/constants/enums';
import type {
  AllocationCommand,
  AllocationResult,
  INetworkTelemetryPort,
  NetworkCapacity,
  SliceTelemetry,
  TelemetryCapabilities,
  TelemetrySampleRequest,
  TelemetrySubject,
} from '@/interfaces/telemetry.port';
import type { SlaTargets } from '@/models/slice.model';
import { clamp, round, safeDivide } from '@/utils/math';
import { TelemetryUnavailableError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';
import { assessHealth } from '../synthetic/health';

const log = createLogger('prometheus-telemetry');

/**
 * Prometheus-backed telemetry adapter for 3GPP cores.
 *
 * Serves Open5GS and free5GC, both of which expose per-slice counters through a Prometheus
 * exporter, and works unchanged against any O-RAN SMO or SDN controller that publishes to
 * Prometheus.
 *
 * WHY THE QUERIES ARE CONFIGURABLE RATHER THAN HARD-CODED
 * =======================================================
 * Metric names differ between Open5GS and free5GC, between minor versions of each, and
 * between exporter configurations — a site running kube-prometheus with relabelling will
 * not have the same series names as a bare-metal install. Hard-coding a metric name is the
 * single most common reason a telemetry integration breaks on upgrade.
 *
 * So each measurement is a PromQL TEMPLATE with `{sst}`, `{sd}` and `{slice}` placeholders.
 * The defaults below target a stock Open5GS deployment; an operator overrides any of them
 * in `PrometheusTelemetryConfig` without a code change.
 *
 * ENFORCEMENT
 * ===========
 * Prometheus is read-only. Pushing an allocation is a separate call against the policy
 * plane — Open5GS's PCF admin API, free5GC's webconsole, or an SDN controller's northbound
 * REST interface — configured as `controlPlane`. When no control plane is configured the
 * adapter reports `enforcement: false` and `applyAllocation` fails loudly rather than
 * silently pretending to have applied a limit, which would leave the platform's model of
 * the network permanently wrong.
 */

export interface PromQueryTemplates {
  /** Offered/attempted bitrate, bits per second. */
  demandBps: string;
  /** Delivered bitrate, bits per second. */
  throughputBps: string;
  /** Round-trip or one-way latency, milliseconds. */
  latencyMs: string;
  /** Delay variation, milliseconds. */
  jitterMs: string;
  /** Packet loss ratio as a percentage. */
  packetLossPercent: string;
  /** User-plane function CPU utilisation, percent. */
  cpuPercent: string;
  memoryPercent: string;
  /** Active PDU sessions on the slice. */
  activeSessions: string;
  /** Optional: total transport capacity in bits per second. */
  capacityBps?: string;
}

/**
 * Defaults targeting a stock Open5GS exporter.
 *
 * `fivegs_*` series follow the naming in 3GPP TS 28.552 performance measurements, which is
 * what Open5GS implements. Latency and loss are typically not emitted by the core itself
 * and are taken from a node exporter or an active probe, hence the differing series names.
 */
export const OPEN5GS_DEFAULT_QUERIES: PromQueryTemplates = Object.freeze({
  demandBps:
    'sum(rate(fivegs_upffunction_upf_datavolumeqosleveldl_total{snssai_sst="{sst}",snssai_sd="{sd}"}[1m])) * 8',
  throughputBps:
    'sum(rate(fivegs_upffunction_upf_datavolumeqoslevelul_total{snssai_sst="{sst}",snssai_sd="{sd}"}[1m])) * 8',
  latencyMs:
    'avg(slice_rtt_milliseconds{snssai_sst="{sst}",snssai_sd="{sd}"})',
  jitterMs:
    'avg(slice_jitter_milliseconds{snssai_sst="{sst}",snssai_sd="{sd}"})',
  packetLossPercent:
    'avg(slice_packet_loss_ratio{snssai_sst="{sst}",snssai_sd="{sd}"}) * 100',
  cpuPercent:
    'avg(rate(process_cpu_seconds_total{job="open5gs-upf"}[1m])) * 100',
  memoryPercent:
    'avg(process_resident_memory_bytes{job="open5gs-upf"}) / avg(node_memory_MemTotal_bytes) * 100',
  activeSessions:
    'sum(fivegs_smffunction_sm_sessionnbr{snssai_sst="{sst}",snssai_sd="{sd}"})',
  capacityBps: 'sum(node_network_speed_bytes{device!~"lo|veth.*"}) * 8',
});

export const FREE5GC_DEFAULT_QUERIES: PromQueryTemplates = Object.freeze({
  ...OPEN5GS_DEFAULT_QUERIES,
  demandBps: 'sum(rate(free5gc_upf_rx_bytes_total{sst="{sst}",sd="{sd}"}[1m])) * 8',
  throughputBps: 'sum(rate(free5gc_upf_tx_bytes_total{sst="{sst}",sd="{sd}"}[1m])) * 8',
  activeSessions: 'sum(free5gc_smf_pdu_sessions{sst="{sst}",sd="{sd}"})',
});

export interface ControlPlaneConfig {
  /**
   * Endpoint that enforces bandwidth. For Open5GS this is typically a PCF policy-update
   * endpoint or an operator-supplied shim in front of it.
   */
  baseUrl: string;
  /** HTTP method and path template for a bandwidth update. */
  method: 'POST' | 'PUT' | 'PATCH';
  pathTemplate: string;
  /** Bearer token or API key, injected as `Authorization`. */
  token?: string;
  timeoutMs: number;
}

export interface PrometheusTelemetryConfig {
  /** e.g. `http://prometheus.5gc.svc:9090`. */
  baseUrl: string;
  queries: PromQueryTemplates;
  timeoutMs: number;
  /** Bearer token for a secured Prometheus. */
  token?: string;
  controlPlane?: ControlPlaneConfig;
  /** Provider label reported on `/health/info`. */
  label: string;
}

interface PromInstantResponse {
  status: 'success' | 'error';
  error?: string;
  data?: { resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] };
}

export class PrometheusTelemetryAdapter implements INetworkTelemetryPort {
  readonly name: string;

  private readonly slaTargets = new Map<string, SlaTargets>();

  constructor(private readonly config: PrometheusTelemetryConfig) {
    this.name = config.label;
    log.info(
      { baseUrl: config.baseUrl, enforcement: Boolean(config.controlPlane) },
      'prometheus telemetry provider initialised',
    );
  }

  capabilities(): TelemetryCapabilities {
    return {
      enforcement: Boolean(this.config.controlPlane),
      computeMetrics: true,
      capacityDiscovery: Boolean(this.config.queries.capacityBps),
      streaming: false,
      // Prometheus scrape intervals are typically 15 s; the rate() windows above are 1 m.
      // Reporting this honestly matters: arbitration confidence is discounted for stale
      // telemetry, and claiming 2-second freshness here would inflate confidence in
      // decisions made on minute-old data.
      nominalSampleAgeMs: 60_000,
    };
  }

  registerSlaTargets(sliceId: string, targets: SlaTargets): void {
    this.slaTargets.set(sliceId, targets);
  }

  async sample(request: TelemetrySampleRequest): Promise<SliceTelemetry[]> {
    // One batch of queries per slice, all issued concurrently. A slice whose queries fail
    // yields an UNKNOWN sample rather than failing the whole batch — one broken exporter
    // must not blind the platform to the rest of the network.
    return Promise.all(
      request.subjects.map((subject) =>
        this.sampleOne(subject, request.atMs).catch((error: unknown) => {
          log.warn({ sliceId: subject.sliceId, err: error }, 'slice telemetry query failed');
          return unknownSample(subject, request.atMs);
        }),
      ),
    );
  }

  private async sampleOne(subject: TelemetrySubject, atMs: number): Promise<SliceTelemetry> {
    const q = this.config.queries;
    const bind = (template: string) => this.bind(template, subject);

    const [
      demandBps,
      throughputBps,
      latencyMs,
      jitterMs,
      packetLossPercent,
      cpuPercent,
      memoryPercent,
      activeSessions,
    ] = await Promise.all([
      this.instant(bind(q.demandBps)),
      this.instant(bind(q.throughputBps)),
      this.instant(bind(q.latencyMs)),
      this.instant(bind(q.jitterMs)),
      this.instant(bind(q.packetLossPercent)),
      this.instant(bind(q.cpuPercent)),
      this.instant(bind(q.memoryPercent)),
      this.instant(bind(q.activeSessions)),
    ]);

    const demandMbps = round(bpsToMbps(demandBps ?? 0), 3);
    const usedMbps = round(Math.min(bpsToMbps(throughputBps ?? 0), subject.allocatedMbps), 3);
    const utilisation = round(safeDivide(usedMbps, subject.allocatedMbps, 0), 4);

    const metrics = {
      latencyMs: round(latencyMs ?? 0, 3),
      jitterMs: round(jitterMs ?? 0, 3),
      packetLossPercent: round(clamp(packetLossPercent ?? 0, 0, 100), 4),
      cpuPercent: round(clamp(cpuPercent ?? 0, 0, 100), 2),
      memoryPercent: round(clamp(memoryPercent ?? 0, 0, 100), 2),
      usedMbps,
      demandMbps,
    };

    const targets = this.slaTargets.get(subject.sliceId);
    const assessment = targets ? assessHealth(metrics, targets) : null;

    return {
      sliceId: subject.sliceId,
      atMs,
      demandMbps,
      allocatedMbps: subject.allocatedMbps,
      usedMbps,
      latencyMs: metrics.latencyMs,
      jitterMs: metrics.jitterMs,
      packetLossPercent: metrics.packetLossPercent,
      cpuPercent: metrics.cpuPercent,
      memoryPercent: metrics.memoryPercent,
      activeSessions: Math.max(0, Math.round(activeSessions ?? 0)),
      utilisation,
      health: assessment?.health ?? HealthState.UNKNOWN,
      healthScore: assessment?.healthScore ?? 100,
      ...(assessment
        ? {
            extra: {
              slaStress: assessment.slaStress,
              breaches: assessment.breaches.join(',') || 'none',
              source: this.name,
            },
          }
        : {}),
    };
  }

  /** Substitute S-NSSAI and slice identifiers into a PromQL template. */
  private bind(template: string, subject: TelemetrySubject): string {
    return template
      .replaceAll('{sst}', String(subject.snssai.sst))
      // Open5GS labels an absent SD as an empty string, not as a missing label.
      .replaceAll('{sd}', subject.snssai.sd ?? '')
      .replaceAll('{slice}', subject.code);
  }

  /** Execute an instant query and return the first scalar, or null when there is no data. */
  private async instant(query: string): Promise<number | null> {
    const url = new URL('/api/v1/query', this.config.baseUrl);
    url.searchParams.set('query', query);

    const response = await this.fetchJson<PromInstantResponse>(url, {
      ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
    });

    if (response.status !== 'success') {
      throw new TelemetryUnavailableError(this.name, response.error ?? 'query failed');
    }

    const first = response.data?.result?.[0];
    if (!first) return null; // Absent series — legitimate for a slice with no traffic.

    const value = Number.parseFloat(first.value[1]);
    return Number.isFinite(value) ? value : null;
  }

  async applyAllocation(commands: AllocationCommand[]): Promise<AllocationResult[]> {
    const control = this.config.controlPlane;

    if (!control) {
      // Failing loudly is essential. Silently reporting success would leave the platform
      // believing a slice is limited to 400 Mbps while the network still permits 800,
      // and every subsequent arbitration decision would be computed against a fiction.
      return commands.map((command) => ({
        sliceId: command.sliceId,
        applied: false,
        effectiveMbps: command.previousMbps,
        error:
          'No control plane configured for this telemetry provider; bandwidth cannot be enforced. ' +
          'Set controlPlane.baseUrl to the policy endpoint (Open5GS PCF, free5GC webconsole, ' +
          'or SDN controller northbound API).',
      }));
    }

    return Promise.all(
      commands.map(async (command) => {
        try {
          const path = control.pathTemplate
            .replaceAll('{sliceId}', encodeURIComponent(command.sliceId))
            .replaceAll('{slice}', encodeURIComponent(command.code))
            .replaceAll('{sst}', String(command.snssai.sst))
            .replaceAll('{sd}', command.snssai.sd ?? '');

          const url = new URL(path, control.baseUrl);

          await this.fetchJson<unknown>(
            url,
            {
              'Content-Type': 'application/json',
              ...(control.token ? { Authorization: `Bearer ${control.token}` } : {}),
            },
            {
              method: control.method,
              body: JSON.stringify({
                snssai: command.snssai,
                sliceCode: command.code,
                // 3GPP expresses session-AMBR in bits per second.
                maxBitRateDl: Math.round(command.targetMbps * 1_000_000),
                maxBitRateUl: Math.round(command.targetMbps * 1_000_000),
                reason: command.reason,
                decisionId: command.decisionId,
              }),
              timeoutMs: control.timeoutMs,
            },
          );

          return { sliceId: command.sliceId, applied: true, effectiveMbps: command.targetMbps };
        } catch (error) {
          log.error({ sliceId: command.sliceId, err: error }, 'allocation enforcement failed');
          return {
            sliceId: command.sliceId,
            applied: false,
            effectiveMbps: command.previousMbps,
            error: error instanceof Error ? error.message : 'enforcement failed',
          };
        }
      }),
    );
  }

  async describeCapacity(): Promise<NetworkCapacity> {
    const template = this.config.queries.capacityBps;
    if (!template) {
      throw new TelemetryUnavailableError(
        this.name,
        'capacityBps query is not configured; cannot discover transport capacity',
      );
    }

    const bps = await this.instant(template);
    if (bps === null) {
      throw new TelemetryUnavailableError(this.name, 'capacity query returned no data');
    }

    const totalMbps = round(bpsToMbps(bps), 2);
    // Reserve 5 % for signalling and OAM, matching common transport engineering practice.
    const reservedMbps = round(totalMbps * 0.05, 2);

    return {
      totalMbps,
      reservedMbps,
      offeredMbps: round(totalMbps - reservedMbps, 2),
      source: 'discovery',
    };
  }

  async ping(): Promise<void> {
    const url = new URL('/-/healthy', this.config.baseUrl);
    await this.fetchText(url);
  }

  /* ------------------------------------------------------------------ */

  private async fetchJson<T>(
    url: URL,
    headers: Record<string, string>,
    init: { method?: string; body?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const response = await this.request(url, headers, init);
    return (await response.json()) as T;
  }

  private async fetchText(url: URL): Promise<string> {
    const response = await this.request(url, {}, {});
    return response.text();
  }

  private async request(
    url: URL,
    headers: Record<string, string>,
    init: { method?: string; body?: string; timeoutMs?: number },
  ): Promise<Response> {
    // An unbounded fetch would let a wedged Prometheus stall the telemetry tick
    // indefinitely, and with it the entire contention-detection loop.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      init.timeoutMs ?? this.config.timeoutMs,
    );

    try {
      const response = await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body ? { body: init.body } : {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new TelemetryUnavailableError(
          this.name,
          `${response.status} ${response.statusText} from ${url.pathname}`,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TelemetryUnavailableError(this.name, `request to ${url.pathname} timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function bpsToMbps(bps: number): number {
  return bps / 1_000_000;
}

/**
 * A slice the provider could not report on.
 *
 * The port requires one entry per subject even on failure: silently omitting a slice would
 * remove its allocation from the capacity total and make the network look healthier than
 * it is — precisely when something has already gone wrong.
 */
function unknownSample(subject: TelemetrySubject, atMs: number): SliceTelemetry {
  return {
    sliceId: subject.sliceId,
    atMs,
    demandMbps: 0,
    allocatedMbps: subject.allocatedMbps,
    usedMbps: 0,
    latencyMs: 0,
    jitterMs: 0,
    packetLossPercent: 0,
    cpuPercent: 0,
    memoryPercent: 0,
    activeSessions: 0,
    utilisation: 0,
    health: HealthState.UNKNOWN,
    healthScore: 0,
    extra: { error: 'telemetry query failed' },
  };
}
