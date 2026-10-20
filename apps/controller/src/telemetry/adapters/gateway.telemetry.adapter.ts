import http from 'node:http';
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
import type { SlaAwareProvider } from '@/telemetry';
import { assessHealth } from '@/telemetry/synthetic/health';
import { createLogger } from '@/utils/logger';

const log = createLogger('gateway-telemetry-adapter');

export interface GatewayAdapterConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export interface GatewaySliceStats {
  code: string;
  atMs: number;
  demandKbps: number;
  limitKbps: number;
  usedKbps: number;
  droppedKbps: number;
  queueMs: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  jitterMs: number | null;
  lossPct: number;
  availabilityPct: number | null;
  activeDevices: number;
  activeSessions: number;
  saturated: boolean;
}

export class GatewayTelemetryAdapter implements INetworkTelemetryPort, SlaAwareProvider {
  public readonly name = 'gateway';
  private baseUrl: string;
  private token: string;
  private timeoutMs: number;
  private slaTargets = new Map<string, SlaTargets>();

  constructor(config: GatewayAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 3000;
  }

  public registerSlaTargets(sliceId: string, targets: SlaTargets): void {
    this.slaTargets.set(sliceId, targets);
  }

  public capabilities(): TelemetryCapabilities {
    return {
      enforcement: true,
      computeMetrics: false,
      capacityDiscovery: true,
      streaming: false,
      nominalSampleAgeMs: 2000,
    };
  }

  private async requestJson<T>(
    method: string,
    pathname: string,
    body?: any,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + pathname);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              return reject(new Error(`Gateway error ${res.statusCode}: ${data}`));
            }
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`Gateway request to ${pathname} timed out after ${timeoutMs}ms`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /** Gateway uptime in seconds; it drops back to ~0 when the gateway restarts. */
  public async uptimeSeconds(): Promise<number> {
    const res = await this.requestJson<{ ok: boolean; uptimeS?: number }>('GET', '/v1/health');
    return Number(res.uptimeS ?? 0);
  }

  public async ping(): Promise<void> {
    const res = await this.requestJson<{ ok: boolean }>('GET', '/v1/health');
    if (!res.ok) {
      throw new Error('Gateway reported non-OK health status');
    }
  }

  public async describeCapacity(): Promise<NetworkCapacity> {
    const cap = await this.requestJson<{
      totalKbps: number;
      reservedKbps: number;
      offeredKbps: number;
    }>('GET', '/v1/capacity');

    return {
      totalMbps: cap.totalKbps,
      reservedMbps: cap.reservedKbps,
      offeredMbps: cap.offeredKbps,
      source: 'configuration',
    };
  }

  public async pushCatalogue(slices: any[]): Promise<void> {
    await this.requestJson('PUT', '/v1/slices', slices);
    log.info({ count: slices.length }, 'pushed slice catalogue to gateway');
  }

  /** Devices that have joined a slice and were seen in the last 15 s. */
  public async listDevices(): Promise<unknown[]> {
    return this.requestJson<unknown[]>('GET', '/v1/devices');
  }

  /** Remove a device from its slice and end its traffic. */
  public async unbindDevice(deviceId: string): Promise<boolean> {
    try {
      await this.requestJson('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`);
      return true;
    } catch {
      return false;
    }
  }

  /** Operator remote control: the slice's devices switch to this demand. */
  public async setDemand(sliceCode: string, kbps: number, mode?: 'local' | 'internet'): Promise<void> {
    await this.requestJson('POST', `/v1/slices/${encodeURIComponent(sliceCode)}/demand`, {
      kbps,
      ...(mode ? { mode } : {}),
    });
  }

  /** The gateway's last completed measurement window, exactly as measured (nulls = unknown). */
  public async readStats(): Promise<GatewaySliceStats[]> {
    return this.requestJson<GatewaySliceStats[]>('GET', '/v1/stats');
  }

  public async sample(request: TelemetrySampleRequest): Promise<SliceTelemetry[]> {
    let statsList: GatewaySliceStats[] = [];
    let isGatewayDown = false;

    try {
      statsList = await this.requestJson<GatewaySliceStats[]>('GET', '/v1/stats');
    } catch (err: any) {
      log.warn({ error: err.message }, 'gateway unreachable during telemetry sample; returning UNKNOWN');
      isGatewayDown = true;
    }

    const statsByCode = new Map<string, GatewaySliceStats>();
    for (const s of statsList) {
      statsByCode.set(s.code, s);
    }

    const result: SliceTelemetry[] = [];

    for (const subject of request.subjects) {
      const stats = statsByCode.get(subject.code);

      if (isGatewayDown || !stats) {
        // Return UNKNOWN when missing or gateway unreachable (contract requirement)
        result.push({
          sliceId: subject.sliceId,
          atMs: request.atMs,
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
        });
        continue;
      }

      const demandMbps = stats.demandKbps;
      const usedMbps = stats.usedKbps;
      const allocatedMbps = stats.limitKbps;
      const latencyMs = stats.latencyP95Ms ?? 0;
      const jitterMs = stats.jitterMs ?? 0;
      const packetLossPercent = stats.lossPct;
      const activeSessions = stats.activeSessions;
      const utilisation = allocatedMbps > 0 ? usedMbps / allocatedMbps : 0;

      let health: HealthState = HealthState.UNKNOWN;
      let healthScore = 0;

      if (stats.latencyP95Ms !== null) {
        const sla = this.slaTargets.get(subject.sliceId);
        if (sla) {
          const assessment = assessHealth(
            {
              latencyMs,
              jitterMs,
              packetLossPercent,
              usedMbps,
              demandMbps,
              cpuPercent: 0,
              memoryPercent: 0,
            },
            sla
          );
          health = assessment.health;
          healthScore = assessment.healthScore;
        } else {
          health = HealthState.HEALTHY;
          healthScore = 100;
        }
      }

      result.push({
        sliceId: subject.sliceId,
        atMs: request.atMs,
        demandMbps,
        allocatedMbps,
        usedMbps,
        latencyMs,
        jitterMs,
        packetLossPercent,
        cpuPercent: 0,
        memoryPercent: 0,
        activeSessions,
        utilisation,
        health,
        healthScore,
        // Unknown values (no probe answered in the window) are left out rather than shown as 0,
        // which would read as perfect latency or a total outage.
        extra: {
          ...(stats.latencyP50Ms !== null ? { p50Ms: stats.latencyP50Ms } : {}),
          ...(stats.availabilityPct !== null ? { availabilityPct: stats.availabilityPct } : {}),
          queueMs: stats.queueMs,
          droppedKbps: stats.droppedKbps,
          activeDevices: stats.activeDevices,
          saturated: stats.saturated ? 1 : 0,
        },
      });
    }

    return result;
  }

  public async applyAllocation(commands: AllocationCommand[]): Promise<AllocationResult[]> {
    const results: AllocationResult[] = [];

    for (const cmd of commands) {
      try {
        const res = await this.requestJson<{ applied: boolean; effectiveKbps: number }>(
          'PUT',
          `/v1/slices/${cmd.code}/limit`,
          {
            limitKbps: cmd.targetMbps,
            decisionId: cmd.decisionId,
            reason: cmd.reason,
          }
        );

        results.push({
          sliceId: cmd.sliceId,
          applied: res.applied,
          effectiveMbps: res.effectiveKbps,
        });
      } catch (err: any) {
        log.error({ error: err.message, sliceCode: cmd.code }, 'failed to apply limit on gateway');
        results.push({
          sliceId: cmd.sliceId,
          applied: false,
          effectiveMbps: cmd.previousMbps,
          error: err.message,
        });
      }
    }

    return results;
  }
}
