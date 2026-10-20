import type { HealthState } from '@/constants/enums';

/**
 * PORT — Network Telemetry & Control
 *
 * THE SINGLE SEAM BETWEEN THIS PLATFORM AND THE NETWORK.
 * ======================================================
 * Everything above this interface — the capacity monitor, the contention detector, the
 * arbitration engine, the allocation manager, the dashboard — is written against these
 * four methods and nothing else. No module anywhere imports a synthetic generator, a
 * 5G-core SDK, or a Kubernetes client.
 *
 * Replacing the modelled network with a live one is therefore a single change in
 * `telemetry/index.ts`:
 *
 *     TELEMETRY_PROVIDER=open5gs
 *
 * Concrete integration points for each target are documented on the adapters in
 * `telemetry/adapters/`.
 *
 * DESIGN NOTE — WHY `applyAllocation` LIVES HERE
 * ==============================================
 * It would be tempting to make this port read-only and treat allocation as a separate
 * concern. That would be wrong: observation and control are two halves of the same
 * integration. Whatever system reports a slice's throughput is the system that enforces its
 * limit — Open5GS's PCF, an SDN controller's flow rules, a Kubernetes NetworkPolicy. Splitting
 * them across two ports would force every deployment to configure two adapters that must
 * agree about slice identity, which is a reliable source of production incidents.
 */

export interface TelemetryCapabilities {
  /** Whether `applyAllocation` actually enforces limits, or only records intent. */
  enforcement: boolean;
  /** Whether the provider reports compute metrics (CPU/memory) per slice. */
  computeMetrics: boolean;
  /** Whether the provider can report total transport capacity. */
  capacityDiscovery: boolean;
  /** Whether metrics are pushed by the provider rather than polled. */
  streaming: boolean;
  /** Typical age of a sample, in milliseconds. Feeds arbitration confidence scoring. */
  nominalSampleAgeMs: number;
}

/** The subset of slice state the network layer needs in order to report on a slice. */
export interface TelemetrySubject {
  sliceId: string;
  code: string;
  /** 3GPP S-NSSAI — how a real core identifies the slice. */
  snssai: { sst: number; sd?: string };
  allocatedMbps: number;
  baselineAllocatedMbps: number;
  minGuaranteedMbps: number;
  maxBurstMbps: number;
  /** Deterministic seed for reproducible synthetic traffic. Ignored by live adapters. */
  telemetrySeed?: number;
  /** Carried through for adapters that key on it; NOT used for arbitration. */
  profile: string;
}

export interface TelemetrySampleRequest {
  subjects: TelemetrySubject[];
  /** Epoch ms the sample is taken for; injected so replays are deterministic. */
  atMs: number;
}

/**
 * One observation of one slice.
 *
 * `demandMbps` and `usedMbps` are deliberately DISTINCT:
 *
 *   demand — what the slice's traffic sources are trying to send. Independent of what the
 *            network grants. Reducing a slice's allocation does not reduce its demand.
 *   used   — what actually got through, bounded by the allocation.
 *
 * The gap between them IS the contention signal. A telemetry source where demand collapses
 * to match allocation would make every contention event resolve itself the instant it was
 * mitigated, and the platform would have nothing to arbitrate.
 */
export interface SliceTelemetry {
  sliceId: string;
  atMs: number;

  demandMbps: number;
  allocatedMbps: number;
  usedMbps: number;

  latencyMs: number;
  jitterMs: number;
  packetLossPercent: number;

  cpuPercent: number;
  memoryPercent: number;

  activeSessions: number;
  /** Utilisation of the current allocation, in [0, 1+]. */
  utilisation: number;

  health: HealthState;
  healthScore: number;

  /** Provider-specific extras, surfaced in the UI without the core needing to know them. */
  extra?: Record<string, number | string>;
}

/** A bandwidth change the arbitration engine wants pushed into the network. */
export interface AllocationCommand {
  sliceId: string;
  code: string;
  snssai: { sst: number; sd?: string };
  targetMbps: number;
  previousMbps: number;
  /** Decision that produced this command; carried into provider audit logs. */
  decisionId: string;
  reason: string;
}

export interface AllocationResult {
  sliceId: string;
  applied: boolean;
  /** What the network actually enforced; may differ from the request on a real system. */
  effectiveMbps: number;
  error?: string;
}

export interface NetworkCapacity {
  totalMbps: number;
  /** Reserved for signalling/OAM and never offered to slices. */
  reservedMbps: number;
  offeredMbps: number;
  /** Where the numbers came from — `configuration` for the modelled network. */
  source: 'configuration' | 'discovery';
}

export interface INetworkTelemetryPort {
  readonly name: string;

  capabilities(): TelemetryCapabilities;

  /**
   * Observe the current state of the given slices.
   *
   * MUST return one entry per requested subject, in any order. A provider that cannot
   * report a slice must still emit an entry with `health: UNKNOWN` rather than omitting it
   * — a silently missing slice would drop out of the capacity total and make the network
   * look healthier than it is.
   */
  sample(request: TelemetrySampleRequest): Promise<SliceTelemetry[]>;

  /**
   * Push new bandwidth limits into the network.
   *
   * MUST be idempotent: the allocation manager retries on partial failure, and the
   * recovery scheduler may re-issue a restore command for a slice already at baseline.
   */
  applyAllocation(commands: AllocationCommand[]): Promise<AllocationResult[]>;

  describeCapacity(): Promise<NetworkCapacity>;

  ping(): Promise<void>;

  dispose?(): Promise<void>;
}
