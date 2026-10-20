import { OFFERED_CAPACITY_MBPS, env } from '@/config/env';
import { HealthState, SliceProfile } from '@/constants/enums';
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
import { clamp } from '@/utils/math';
import { createLogger } from '@/utils/logger';
import { assessHealth } from './health';
import {
  FaultKind,
  clearFault,
  createSimulationState,
  injectFault,
  stepTraffic,
  type SliceSimulationState,
} from './trafficModel';

const log = createLogger('synthetic-telemetry');

/**
 * Synthetic network telemetry adapter.
 *
 * Implements `INetworkTelemetryPort` against the traffic physics in `trafficModel.ts`.
 * It behaves like a real network feed in every way the rest of the platform can observe:
 *
 *   • metrics evolve continuously and are autocorrelated between samples,
 *   • demand is independent of allocation, so contention persists until arbitrated,
 *   • applying an allocation has measurable consequences on the next sample,
 *   • per-slice state survives across ticks and is reproducible from a seed.
 *
 * WHAT IT IS NOT
 * ==============
 * It is not a mock and not a stand-in for tests — the platform runs against it in
 * development exactly as it would run against Open5GS in production, through the same
 * port, with the same call sequence and the same failure semantics.
 *
 * SLA targets are supplied per sample rather than held here: health is scored against each
 * slice's own contract, and those contracts change through the API while the process runs.
 */
export class SyntheticTelemetryAdapter implements INetworkTelemetryPort {
  readonly name = 'synthetic';

  private readonly states = new Map<string, SliceSimulationState>();
  private readonly slaTargets = new Map<string, SlaTargets>();

  /**
   * Effective allocations as the "network" has them.
   *
   * Kept separate from the slice records in the datastore ON PURPOSE. A real core is the
   * authority on what is actually enforced, and it can disagree with what the platform
   * believes — a command may have failed, or a limit may have been changed out-of-band.
   * Modelling that gap means the allocation manager's reconciliation logic gets exercised
   * in development instead of meeting the possibility for the first time in production.
   */
  private readonly enforcedAllocations = new Map<string, number>();

  /** Operator-driven global load multiplier, used to drive the fleet into contention. */
  private globalLoadMultiplier = 1;

  private sampleCount = 0;

  constructor(private readonly options: { globalLoadMultiplier?: number } = {}) {
    this.globalLoadMultiplier = options.globalLoadMultiplier ?? 1;
    log.info('synthetic telemetry provider initialised');
  }

  capabilities(): TelemetryCapabilities {
    return {
      enforcement: true,
      computeMetrics: true,
      capacityDiscovery: true,
      streaming: false,
      nominalSampleAgeMs: env.TELEMETRY_TICK_MS,
    };
  }

  /**
   * Register or refresh a slice's SLA targets.
   *
   * Called by the telemetry service before each sample. On a live adapter the equivalent
   * is a no-op — the core does not need to know our contracts — which is why it is not on
   * the port.
   */
  registerSlaTargets(sliceId: string, targets: SlaTargets): void {
    this.slaTargets.set(sliceId, targets);
  }

  async sample(request: TelemetrySampleRequest): Promise<SliceTelemetry[]> {
    this.sampleCount += 1;

    const results = request.subjects.map((subject) => this.sampleOne(subject, request.atMs));

    // Drop simulation state for slices that have disappeared, so a long-running process
    // does not accumulate state for deleted slices.
    const live = new Set(request.subjects.map((s) => s.sliceId));
    for (const sliceId of [...this.states.keys()]) {
      if (!live.has(sliceId)) {
        this.states.delete(sliceId);
        this.slaTargets.delete(sliceId);
        this.enforcedAllocations.delete(sliceId);
      }
    }

    return results;
  }

  private sampleOne(subject: TelemetrySubject, atMs: number): SliceTelemetry {
    let state = this.states.get(subject.sliceId);
    if (!state) {
      state = createSimulationState(
        subject.sliceId,
        subject.telemetrySeed,
        toProfile(subject.profile),
      );
      this.states.set(subject.sliceId, state);
    }

    // The network enforces what it was last told to enforce, not what the datastore
    // believes. They agree in the normal case; the difference matters when a command
    // failed, and reconciliation depends on being able to see it.
    const enforced = this.enforcedAllocations.get(subject.sliceId) ?? subject.allocatedMbps;

    const traffic = stepTraffic(state, {
      profile: toProfile(subject.profile),
      baselineAllocatedMbps: subject.baselineAllocatedMbps,
      allocatedMbps: enforced,
      maxBurstMbps: subject.maxBurstMbps,
      atMs,
      globalLoadMultiplier: this.globalLoadMultiplier,
    });

    const targets = this.slaTargets.get(subject.sliceId);

    // Without SLA targets we can report metrics but must not claim to know whether they
    // are acceptable. UNKNOWN is the honest answer.
    if (!targets) {
      return {
        sliceId: subject.sliceId,
        atMs,
        demandMbps: traffic.demandMbps,
        allocatedMbps: enforced,
        usedMbps: traffic.usedMbps,
        latencyMs: traffic.latencyMs,
        jitterMs: traffic.jitterMs,
        packetLossPercent: traffic.packetLossPercent,
        cpuPercent: traffic.cpuPercent,
        memoryPercent: traffic.memoryPercent,
        activeSessions: traffic.activeSessions,
        utilisation: traffic.utilisation,
        health: HealthState.UNKNOWN,
        healthScore: 100,
      };
    }

    const assessment = assessHealth(
      {
        latencyMs: traffic.latencyMs,
        jitterMs: traffic.jitterMs,
        packetLossPercent: traffic.packetLossPercent,
        usedMbps: traffic.usedMbps,
        demandMbps: traffic.demandMbps,
        cpuPercent: traffic.cpuPercent,
        memoryPercent: traffic.memoryPercent,
      },
      targets,
    );

    return {
      sliceId: subject.sliceId,
      atMs,
      demandMbps: traffic.demandMbps,
      allocatedMbps: enforced,
      usedMbps: traffic.usedMbps,
      latencyMs: traffic.latencyMs,
      jitterMs: traffic.jitterMs,
      packetLossPercent: traffic.packetLossPercent,
      cpuPercent: traffic.cpuPercent,
      memoryPercent: traffic.memoryPercent,
      activeSessions: traffic.activeSessions,
      utilisation: traffic.utilisation,
      health: assessment.health,
      healthScore: assessment.healthScore,
      extra: {
        slaStress: assessment.slaStress,
        latencyStress: assessment.breakdown.latency,
        lossStress: assessment.breakdown.packetLoss,
        breaches: assessment.breaches.join(',') || 'none',
        simulationTick: state.tick,
        activeFault: state.faultKind ?? 'none',
      },
    };
  }

  /**
   * Apply bandwidth limits.
   *
   * Idempotent, as the port requires: re-issuing the same target is a no-op, which the
   * recovery scheduler relies on when it re-asserts a baseline for a slice already there.
   */
  async applyAllocation(commands: AllocationCommand[]): Promise<AllocationResult[]> {
    return commands.map((command) => {
      const target = Math.max(0, command.targetMbps);
      this.enforcedAllocations.set(command.sliceId, target);

      log.debug(
        {
          sliceId: command.sliceId,
          code: command.code,
          from: command.previousMbps,
          to: target,
          decisionId: command.decisionId,
        },
        'allocation enforced',
      );

      return { sliceId: command.sliceId, applied: true, effectiveMbps: target };
    });
  }

  async describeCapacity(): Promise<NetworkCapacity> {
    return {
      totalMbps: env.NETWORK_TOTAL_CAPACITY_MBPS,
      reservedMbps: env.NETWORK_RESERVED_CAPACITY_MBPS,
      offeredMbps: OFFERED_CAPACITY_MBPS,
      source: 'configuration',
    };
  }

  async ping(): Promise<void> {
    // Entirely local; nothing to reach.
  }

  async dispose(): Promise<void> {
    this.states.clear();
    this.slaTargets.clear();
    this.enforcedAllocations.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Operator controls (synthetic provider only)                         */
  /* ------------------------------------------------------------------ */

  /**
   * Scale demand across the whole fleet.
   *
   * The intended use is driving the network into contention on demand — for a
   * demonstration, an operational rehearsal, or an end-to-end test of the control loop.
   * On a live network the equivalent is a traffic generator, which is why this is not on
   * the port.
   */
  setGlobalLoad(multiplier: number): number {
    this.globalLoadMultiplier = clamp(multiplier, 0.1, 10);
    log.warn({ multiplier: this.globalLoadMultiplier }, 'global synthetic load changed');
    return this.globalLoadMultiplier;
  }

  getGlobalLoad(): number {
    return this.globalLoadMultiplier;
  }

  /** Inject a fault into one slice for a number of ticks. */
  injectFault(sliceId: string, kind: FaultKind, durationTicks: number): boolean {
    const state = this.states.get(sliceId);
    if (!state) return false;
    injectFault(state, kind, durationTicks);
    log.warn({ sliceId, kind, durationTicks }, 'fault injected');
    return true;
  }

  clearFault(sliceId: string): boolean {
    const state = this.states.get(sliceId);
    if (!state) return false;
    clearFault(state);
    return true;
  }

  /** Diagnostic snapshot, exposed on the Settings → Telemetry screen. */
  describeState(): {
    provider: string;
    trackedSlices: number;
    sampleCount: number;
    globalLoadMultiplier: number;
    activeFaults: { sliceId: string; kind: string; ticksRemaining: number }[];
  } {
    return {
      provider: this.name,
      trackedSlices: this.states.size,
      sampleCount: this.sampleCount,
      globalLoadMultiplier: this.globalLoadMultiplier,
      activeFaults: [...this.states.values()]
        .filter((s) => s.faultKind !== null)
        .map((s) => ({
          sliceId: s.sliceId,
          kind: s.faultKind as string,
          ticksRemaining: s.faultTicksRemaining,
        })),
    };
  }
}

function toProfile(value: string): SliceProfile {
  return (Object.values(SliceProfile) as string[]).includes(value)
    ? (value as SliceProfile)
    : SliceProfile.EMBB;
}

export { FaultKind };
