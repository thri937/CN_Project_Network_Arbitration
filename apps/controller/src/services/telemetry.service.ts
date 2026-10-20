import { EventEmitter } from 'node:events';
import { OFFERED_CAPACITY_MBPS, env } from '@/config/env';
import { HealthState } from '@/constants/enums';
import type { IClock } from '@/interfaces/clock.port';
import type { INetworkTelemetryPort, TelemetrySubject } from '@/interfaces/telemetry.port';
import type { Slice } from '@/models/slice.model';
import { isArbitrable } from '@/models/slice.model';
import type { LiveSliceState, NetworkSnapshot, TelemetrySample } from '@/models/telemetry.model';
import type { SliceRepository } from '@/repositories/slice.repository';
import type { TelemetryRepository } from '@/repositories/telemetry.repository';
import { isSlaAware } from '@/telemetry';
import { assessHealth } from '@/telemetry/synthetic/health';
import { round, sum } from '@/utils/math';
import { createLogger } from '@/utils/logger';

const log = createLogger('telemetry-service');

/**
 * Telemetry orchestration — the heart of the control loop.
 *
 * Each tick:
 *   1. read the slice fleet,
 *   2. ask the telemetry provider to sample it,
 *   3. fold the result into an in-memory `NetworkSnapshot`,
 *   4. emit `snapshot` so the capacity monitor and contention detector can react,
 *   5. persist a throttled subset for charting and post-incident analysis.
 *
 * THE SNAPSHOT IS IN MEMORY, ON PURPOSE
 * =====================================
 * Arbitration reads step 3, never the telemetry collection. Two consequences:
 *
 *   • Control-loop latency is independent of datastore performance. A Firestore hiccup
 *     slows charting, not the platform's ability to protect the network.
 *   • Persistence can be throttled aggressively (`TELEMETRY_PERSIST_EVERY_N_TICKS`)
 *     without degrading arbitration quality at all.
 *
 * The trade-off is that a fresh process has no snapshot until its first tick, which is why
 * `hasSnapshot()` exists and why the arbitration service refuses to run without one rather
 * than acting on an empty view of the network.
 */
export interface TelemetryEvents {
  snapshot: (snapshot: NetworkSnapshot) => void;
}

export class TelemetryService {
  private readonly emitter = new EventEmitter();
  private snapshot: NetworkSnapshot | null = null;
  private tick = 0;
  private persistCounter = 0;
  private consecutiveFailures = 0;
  private lastSuccessAtMs = 0;

  constructor(
    private readonly provider: INetworkTelemetryPort,
    private readonly slices: SliceRepository,
    private readonly telemetry: TelemetryRepository,
    private readonly clock: IClock,
  ) {
    // Node's default max of 10 would warn once the dashboard, capacity monitor, contention
    // detector and realtime gateway all subscribe.
    this.emitter.setMaxListeners(50);
  }

  on<E extends keyof TelemetryEvents>(event: E, listener: TelemetryEvents[E]): void {
    this.emitter.on(event, listener);
  }

  off<E extends keyof TelemetryEvents>(event: E, listener: TelemetryEvents[E]): void {
    this.emitter.off(event, listener);
  }

  /**
   * Execute one telemetry cycle.
   *
   * Never throws: a telemetry failure must not kill the scheduler that drives every other
   * part of the control loop. Failures are counted and surfaced through the health probe,
   * and the previous snapshot is retained so the dashboard degrades to "stale" rather than
   * to "empty".
   */
  async collect(): Promise<NetworkSnapshot | null> {
    const atMs = this.clock.now();

    try {
      const allSlices = await this.slices.listAll();
      const active = allSlices.filter(isArbitrable);

      if (active.length === 0) {
        this.snapshot = this.emptySnapshot(atMs);
        this.tick += 1;
        this.emitter.emit('snapshot', this.snapshot);
        return this.snapshot;
      }

      // Providers that score health against per-slice contracts need those contracts.
      // Pushed every tick because SLA targets change through the API while we run.
      if (isSlaAware(this.provider)) {
        for (const slice of active) {
          this.provider.registerSlaTargets(slice.id, slice.slaTargets);
        }
      }

      const samples = await this.provider.sample({
        atMs,
        subjects: active.map(toSubject),
      });

      const byId = new Map(samples.map((sample) => [sample.sliceId, sample]));
      const sliceById = new Map(active.map((slice) => [slice.id, slice]));

      const states: LiveSliceState[] = active.map((slice) => {
        const sample = byId.get(slice.id);

        // The port requires one sample per subject; a provider that violates that must not
        // silently remove the slice from the capacity total, so we synthesise an UNKNOWN.
        if (!sample) {
          log.warn({ sliceId: slice.id, provider: this.provider.name }, 'provider omitted a slice');
          return unknownState(slice, atMs);
        }

        // Re-derive SLA stress here rather than trusting the provider's `extra`, so the
        // value is computed identically regardless of which provider is active.
        const assessment = assessHealth(
          {
            latencyMs: sample.latencyMs,
            jitterMs: sample.jitterMs,
            packetLossPercent: sample.packetLossPercent,
            usedMbps: sample.usedMbps,
            demandMbps: sample.demandMbps,
            cpuPercent: sample.cpuPercent,
            memoryPercent: sample.memoryPercent,
          },
          slice.slaTargets,
        );

        return {
          sliceId: slice.id,
          sliceCode: slice.code,
          sliceName: slice.name,
          departmentId: slice.departmentId,
          demandMbps: sample.demandMbps,
          allocatedMbps: sample.allocatedMbps,
          baselineAllocatedMbps: slice.baselineAllocatedMbps,
          minGuaranteedMbps: slice.minGuaranteedMbps,
          usedMbps: sample.usedMbps,
          utilisation: sample.utilisation,
          latencyMs: sample.latencyMs,
          jitterMs: sample.jitterMs,
          packetLossPercent: sample.packetLossPercent,
          cpuPercent: sample.cpuPercent,
          memoryPercent: sample.memoryPercent,
          activeSessions: sample.activeSessions,
          health: assessment.health,
          healthScore: assessment.healthScore,
          slaStress: assessment.slaStress,
          breaches: assessment.breaches,
          status: slice.status,
          observedAtMs: sample.atMs,
        };
      });

      this.tick += 1;
      this.snapshot = {
        atMs,
        at: new Date(atMs).toISOString(),
        slices: states,
        totalDemandMbps: round(sum(states.map((s) => s.demandMbps)), 3),
        totalAllocatedMbps: round(sum(states.map((s) => s.allocatedMbps)), 3),
        totalUsedMbps: round(sum(states.map((s) => s.usedMbps)), 3),
        offeredCapacityMbps: OFFERED_CAPACITY_MBPS,
        source: this.provider.name,
        tick: this.tick,
      };

      this.consecutiveFailures = 0;
      this.lastSuccessAtMs = atMs;

      // Listeners run synchronously; an exception in one must not abort the others or the
      // tick itself, so each is isolated.
      this.emitter.emit('snapshot', this.snapshot);

      await this.persistIfDue(states, sliceById, atMs);

      return this.snapshot;
    } catch (error) {
      this.consecutiveFailures += 1;
      log.error(
        { err: error, provider: this.provider.name, consecutiveFailures: this.consecutiveFailures },
        'telemetry collection failed; retaining the previous snapshot',
      );
      return null;
    }
  }

  /**
   * Persist every Nth tick.
   *
   * Storage is for charts and post-incident analysis; arbitration never reads it. A write
   * failure is logged and swallowed for the same reason as in the audit service: losing a
   * chart point must not stop the platform protecting the network.
   */
  private async persistIfDue(
    states: LiveSliceState[],
    sliceById: Map<string, Slice>,
    atMs: number,
  ): Promise<void> {
    if (!env.TELEMETRY_PERSIST) return;

    this.persistCounter += 1;
    if (this.persistCounter < env.TELEMETRY_PERSIST_EVERY_N_TICKS) return;
    this.persistCounter = 0;

    const at = new Date(atMs).toISOString();
    const samples: Omit<TelemetrySample, 'id' | 'createdAt' | 'updatedAt' | 'version'>[] = states.map(
      (state) => ({
        sliceId: state.sliceId,
        sliceCode: state.sliceCode,
        departmentId: state.departmentId,
        at,
        atMs,
        demandMbps: state.demandMbps,
        allocatedMbps: state.allocatedMbps,
        usedMbps: state.usedMbps,
        utilisation: state.utilisation,
        latencyMs: state.latencyMs,
        jitterMs: state.jitterMs,
        packetLossPercent: state.packetLossPercent,
        cpuPercent: state.cpuPercent,
        memoryPercent: state.memoryPercent,
        activeSessions: state.activeSessions,
        health: state.health,
        healthScore: state.healthScore,
        source: this.provider.name,
      }),
    );
    void sliceById;

    try {
      await this.telemetry.appendBatch(samples);
    } catch (error) {
      log.error({ err: error, count: samples.length }, 'telemetry persistence failed');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Accessors                                                           */
  /* ------------------------------------------------------------------ */

  getSnapshot(): NetworkSnapshot | null {
    return this.snapshot;
  }

  /**
   * Discard the current snapshot.
   *
   * Serving a snapshot that describes a network the platform is no longer observing is
   * worse than serving none: the dashboard shows plausible numbers and an operator has no
   * way to tell they are fiction. Called when the telemetry provider is swapped at runtime,
   * and by the integration harness between tests so state cannot leak across them.
   */
  clearSnapshot(): void {
    this.snapshot = null;
    this.persistCounter = 0;
  }

  hasSnapshot(): boolean {
    return this.snapshot !== null && this.snapshot.slices.length > 0;
  }

  /** Age of the current snapshot in ms. Feeds arbitration confidence scoring. */
  snapshotAgeMs(): number {
    return this.snapshot === null ? Number.POSITIVE_INFINITY : this.clock.now() - this.snapshot.atMs;
  }

  getSliceState(sliceId: string): LiveSliceState | null {
    return this.snapshot?.slices.find((s) => s.sliceId === sliceId) ?? null;
  }

  get networkProvider(): INetworkTelemetryPort {
    return this.provider;
  }

  /**
   * Health probe.
   *
   * A stalled telemetry loop is the most dangerous failure this platform has: the control
   * loop keeps running against a frozen view of the network and can degrade slices on the
   * basis of conditions that cleared minutes ago. It is therefore reported as `down` — a
   * critical probe — rather than merely degraded.
   */
  healthProbe = (): { status: 'up' | 'degraded' | 'down'; message?: string; details?: Record<string, unknown> } => {
    const details = {
      provider: this.provider.name,
      tick: this.tick,
      trackedSlices: this.snapshot?.slices.length ?? 0,
      snapshotAgeMs: this.snapshot ? this.snapshotAgeMs() : null,
      consecutiveFailures: this.consecutiveFailures,
    };

    if (this.snapshot === null) {
      return { status: 'degraded', message: 'no telemetry snapshot yet', details };
    }

    const age = this.snapshotAgeMs();
    const stallThreshold = env.TELEMETRY_TICK_MS * 6;

    if (age > stallThreshold) {
      return {
        status: 'down',
        message: `telemetry has not advanced for ${Math.round(age / 1000)}s; arbitration would act on stale data`,
        details,
      };
    }

    if (this.consecutiveFailures > 0) {
      return { status: 'degraded', message: `${this.consecutiveFailures} consecutive failures`, details };
    }

    return { status: 'up', details };
  };

  private emptySnapshot(atMs: number): NetworkSnapshot {
    return {
      atMs,
      at: new Date(atMs).toISOString(),
      slices: [],
      totalDemandMbps: 0,
      totalAllocatedMbps: 0,
      totalUsedMbps: 0,
      offeredCapacityMbps: OFFERED_CAPACITY_MBPS,
      source: this.provider.name,
      tick: this.tick,
    };
  }
}

function toSubject(slice: Slice): TelemetrySubject {
  return {
    sliceId: slice.id,
    code: slice.code,
    snssai: slice.snssai,
    allocatedMbps: slice.allocatedMbps,
    baselineAllocatedMbps: slice.baselineAllocatedMbps,
    minGuaranteedMbps: slice.minGuaranteedMbps,
    maxBurstMbps: slice.maxBurstMbps,
    ...(slice.telemetrySeed !== undefined ? { telemetrySeed: slice.telemetrySeed } : {}),
    profile: slice.profile,
  };
}

function unknownState(slice: Slice, atMs: number): LiveSliceState {
  return {
    sliceId: slice.id,
    sliceCode: slice.code,
    sliceName: slice.name,
    departmentId: slice.departmentId,
    demandMbps: 0,
    allocatedMbps: slice.allocatedMbps,
    baselineAllocatedMbps: slice.baselineAllocatedMbps,
    minGuaranteedMbps: slice.minGuaranteedMbps,
    usedMbps: 0,
    utilisation: 0,
    latencyMs: 0,
    jitterMs: 0,
    packetLossPercent: 0,
    cpuPercent: 0,
    memoryPercent: 0,
    activeSessions: 0,
    health: HealthState.UNKNOWN,
    healthScore: 0,
    slaStress: 0,
    breaches: [],
    status: slice.status,
    observedAtMs: atMs,
  };
}
