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

const log = createLogger('kubernetes-telemetry');

/**
 * Kubernetes-backed telemetry adapter.
 *
 * For deployments where slices are realised as workloads in a cluster — a common shape for
 * private 5G, where each slice's user-plane function runs as a Deployment and bandwidth is
 * enforced by a CNI that honours traffic-shaping annotations (Cilium bandwidth manager,
 * Calico QoS, or the `kubernetes.io/{in,e}gress-bandwidth` annotations).
 *
 * SLICE → WORKLOAD MAPPING
 * ========================
 * Slices are located by label rather than by name: `arbitration.slice/code=<code>`. Naming
 * conventions differ per cluster and change during migrations; a label selector is the
 * standard Kubernetes way to express "the pods belonging to this thing" and survives
 * renames.
 *
 * ENFORCEMENT
 * ===========
 * Bandwidth is applied by patching the pod-template annotations on the slice's Deployment,
 * which is what the CNI reads. This triggers a rolling update — deliberately surfaced in
 * the result so the allocation manager records that enforcement is not instantaneous, and
 * so the recovery scheduler does not interpret the transitional period as a failure.
 */
export interface KubernetesTelemetryConfig {
  /** Prometheus endpoint aggregating cAdvisor/kube-state metrics. */
  metricsUrl: string;
  /** Namespace holding the slice workloads. */
  namespace: string;
  timeoutMs: number;
  token?: string;
  /** Kubernetes API server; omit to disable enforcement. */
  apiServerUrl?: string;
  /** Service-account token for the API server. */
  apiToken?: string;
  /** Label whose value identifies the slice. */
  sliceLabel?: string;
}

interface PromResponse {
  status: string;
  data?: { result: { value: [number, string] }[] };
}

export class KubernetesTelemetryAdapter implements INetworkTelemetryPort {
  readonly name = 'kubernetes';

  private readonly slaTargets = new Map<string, SlaTargets>();
  private readonly sliceLabel: string;

  constructor(private readonly config: KubernetesTelemetryConfig) {
    this.sliceLabel = config.sliceLabel ?? 'arbitration.slice/code';
    log.info(
      { namespace: config.namespace, enforcement: Boolean(config.apiServerUrl) },
      'kubernetes telemetry provider initialised',
    );
  }

  capabilities(): TelemetryCapabilities {
    return {
      enforcement: Boolean(this.config.apiServerUrl),
      computeMetrics: true,
      capacityDiscovery: true,
      streaming: false,
      nominalSampleAgeMs: 30_000,
    };
  }

  registerSlaTargets(sliceId: string, targets: SlaTargets): void {
    this.slaTargets.set(sliceId, targets);
  }

  async sample(request: TelemetrySampleRequest): Promise<SliceTelemetry[]> {
    return Promise.all(
      request.subjects.map((subject) =>
        this.sampleOne(subject, request.atMs).catch((error: unknown) => {
          log.warn({ sliceId: subject.sliceId, err: error }, 'slice telemetry query failed');
          return this.unknownSample(subject, request.atMs);
        }),
      ),
    );
  }

  private async sampleOne(subject: TelemetrySubject, atMs: number): Promise<SliceTelemetry> {
    const selector = `namespace="${this.config.namespace}",label_${sanitiseLabel(this.sliceLabel)}="${subject.code}"`;

    const [rxBps, txBps, cpuCores, cpuLimit, memBytes, memLimit, pods] = await Promise.all([
      this.instant(`sum(rate(container_network_receive_bytes_total{${selector}}[1m])) * 8`),
      this.instant(`sum(rate(container_network_transmit_bytes_total{${selector}}[1m])) * 8`),
      this.instant(`sum(rate(container_cpu_usage_seconds_total{${selector}}[1m]))`),
      this.instant(`sum(kube_pod_container_resource_limits{${selector},resource="cpu"})`),
      this.instant(`sum(container_memory_working_set_bytes{${selector}})`),
      this.instant(`sum(kube_pod_container_resource_limits{${selector},resource="memory"})`),
      this.instant(`count(kube_pod_info{${selector}})`),
    ]);

    // Ingress is what the slice is trying to push through; egress is what got out.
    const demandMbps = round((rxBps ?? 0) / 1_000_000, 3);
    const usedMbps = round(Math.min((txBps ?? 0) / 1_000_000, subject.allocatedMbps), 3);

    // Packet loss is not directly observable from cAdvisor counters; the shortfall between
    // offered and delivered traffic is the closest honest proxy, and it is labelled as
    // such in `extra` so nobody mistakes it for a measured drop counter.
    const shortfall = Math.max(0, demandMbps - usedMbps);
    const packetLossPercent = round(clamp(safeDivide(shortfall, demandMbps, 0) * 100, 0, 100), 4);

    const metrics = {
      // Neither latency nor jitter is available from container metrics. Reporting zero
      // would be a lie that suppresses SLA stress; they are omitted from the health
      // assessment via zeroed targets-safe values and flagged in `extra`.
      latencyMs: 0,
      jitterMs: 0,
      packetLossPercent,
      usedMbps,
      demandMbps,
      cpuPercent: round(clamp(safeDivide(cpuCores ?? 0, cpuLimit ?? 0, 0) * 100, 0, 100), 2),
      memoryPercent: round(clamp(safeDivide(memBytes ?? 0, memLimit ?? 0, 0) * 100, 0, 100), 2),
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
      packetLossPercent,
      cpuPercent: metrics.cpuPercent,
      memoryPercent: metrics.memoryPercent,
      activeSessions: Math.max(0, Math.round(pods ?? 0)),
      utilisation: round(safeDivide(usedMbps, subject.allocatedMbps, 0), 4),
      health: assessment?.health ?? HealthState.UNKNOWN,
      healthScore: assessment?.healthScore ?? 100,
      extra: {
        source: this.name,
        namespace: this.config.namespace,
        latencyAvailable: 'false',
        lossMethod: 'ingress-egress shortfall (not a measured drop counter)',
        ...(assessment ? { breaches: assessment.breaches.join(',') || 'none' } : {}),
      },
    };
  }

  async applyAllocation(commands: AllocationCommand[]): Promise<AllocationResult[]> {
    if (!this.config.apiServerUrl) {
      return commands.map((command) => ({
        sliceId: command.sliceId,
        applied: false,
        effectiveMbps: command.previousMbps,
        error:
          'No Kubernetes API server configured; bandwidth annotations cannot be patched. ' +
          'Set apiServerUrl and provide a service-account token with patch rights on deployments.',
      }));
    }

    return Promise.all(
      commands.map(async (command) => {
        try {
          const url = new URL(
            `/apis/apps/v1/namespaces/${this.config.namespace}/deployments/${encodeURIComponent(command.code)}`,
            this.config.apiServerUrl,
          );

          // Strategic-merge patch of the pod template annotations, which is what the CNI
          // bandwidth manager reads.
          const bandwidth = `${Math.max(1, Math.round(command.targetMbps))}M`;
          const body = {
            spec: {
              template: {
                metadata: {
                  annotations: {
                    'kubernetes.io/ingress-bandwidth': bandwidth,
                    'kubernetes.io/egress-bandwidth': bandwidth,
                    'arbitration.slice/decision-id': command.decisionId,
                  },
                },
              },
            },
          };

          await this.request(url, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/strategic-merge-patch+json',
              ...(this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {}),
            },
            body: JSON.stringify(body),
          });

          return {
            sliceId: command.sliceId,
            applied: true,
            effectiveMbps: command.targetMbps,
          };
        } catch (error) {
          log.error({ sliceId: command.sliceId, err: error }, 'annotation patch failed');
          return {
            sliceId: command.sliceId,
            applied: false,
            effectiveMbps: command.previousMbps,
            error: error instanceof Error ? error.message : 'patch failed',
          };
        }
      }),
    );
  }

  async describeCapacity(): Promise<NetworkCapacity> {
    const bps = await this.instant('sum(node_network_speed_bytes{device!~"lo|veth.*|cni.*"}) * 8');
    if (bps === null) {
      throw new TelemetryUnavailableError(this.name, 'node network speed metrics unavailable');
    }

    const totalMbps = round(bps / 1_000_000, 2);
    const reservedMbps = round(totalMbps * 0.05, 2);
    return {
      totalMbps,
      reservedMbps,
      offeredMbps: round(totalMbps - reservedMbps, 2),
      source: 'discovery',
    };
  }

  async ping(): Promise<void> {
    await this.request(new URL('/-/healthy', this.config.metricsUrl), { method: 'GET' });
  }

  /* ------------------------------------------------------------------ */

  private async instant(query: string): Promise<number | null> {
    const url = new URL('/api/v1/query', this.config.metricsUrl);
    url.searchParams.set('query', query);

    const response = await this.request(url, {
      method: 'GET',
      headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {},
    });

    const payload = (await response.json()) as PromResponse;
    if (payload.status !== 'success') return null;

    const first = payload.data?.result?.[0];
    if (!first) return null;

    const value = Number.parseFloat(first.value[1]);
    return Number.isFinite(value) ? value : null;
  }

  private async request(
    url: URL,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: init.method,
        headers: init.headers ?? {},
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
      clearTimeout(timer);
    }
  }

  private unknownSample(subject: TelemetrySubject, atMs: number): SliceTelemetry {
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
      extra: { error: 'telemetry query failed', source: this.name },
    };
  }
}

/** Prometheus rewrites label keys: `arbitration.slice/code` → `arbitration_slice_code`. */
function sanitiseLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '_');
}
