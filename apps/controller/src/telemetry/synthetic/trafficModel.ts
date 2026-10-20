import { SliceProfile } from '@/constants/enums';
import { clamp, clamp01, lerp, round } from '@/utils/math';
import { createRandom, hashSeed, type RandomSource } from '@/utils/random';

/**
 * SYNTHETIC TRAFFIC PHYSICS
 * =========================
 * This module is what separates a network *model* from a random-number generator.
 *
 * Every quantity below is DERIVED from a small number of state variables through
 * relationships that hold in real packet networks. That matters for three concrete
 * reasons:
 *
 *  1. The arbitration engine's SLA-stress term reads latency and loss. If those were
 *     independent random walks, stress would be noise and the engine's behaviour would be
 *     untestable and unexplainable.
 *
 *  2. Applying a degradation must have OBSERVABLE CONSEQUENCES. Cut a slice's bandwidth and
 *     its utilisation rises, its latency climbs the queueing curve, and loss appears. That
 *     feedback is what makes the dashboard tell the truth and what makes an end-to-end test
 *     of the control loop meaningful.
 *
 *  3. Contention must PERSIST until resolved. Demand is modelled independently of
 *     allocation, so degrading a slice reduces what it receives, never what it wants.
 *
 * THE RELATIONSHIPS
 * -----------------
 *  demand(t)   diurnal base × profile shape × slow random walk × burst envelope
 *  used        min(demand, allocated) — you cannot receive more than you are granted
 *  ρ           used / allocated                                       (utilisation)
 *  latency     base × 1/(1−ρ)  — M/M/1 queueing delay, the source of the "knee"
 *  jitter      scales with the same queueing factor, plus a noise floor
 *  loss        overflow only: appears when demand > allocated, proportional to the excess
 *  cpu/mem     correlated with throughput and session count, with distinct time constants
 *
 * DETERMINISM
 * -----------
 * Every random draw comes from a seeded generator keyed on the slice. Same seed + same tick
 * count ⇒ byte-identical stream. That is what makes a contention scenario replayable
 * against a modified arbitration algorithm.
 */

/* ------------------------------------------------------------------ */
/* Profile characteristics                                             */
/* ------------------------------------------------------------------ */

export interface ProfileCharacteristics {
  /** Nominal one-way latency with an empty queue, in ms. */
  baseLatencyMs: number;
  /** Jitter floor with an empty queue, in ms. */
  baseJitterMs: number;
  /** Mean demand as a fraction of the slice's baseline allocation. */
  meanLoadFactor: number;
  /** Standard deviation of the slow random walk, as a fraction of the mean. */
  loadVolatility: number;
  /** Probability per tick that a traffic burst begins. */
  burstProbability: number;
  /** Multiplier applied to demand during a burst. */
  burstMagnitude: number;
  /** Mean burst duration in ticks. */
  burstDurationTicks: number;
  /** Sessions per Mbps of throughput — mMTC has vastly more, tiny, sessions. */
  sessionsPerMbps: number;
  /** CPU cost per Mbps, as a percentage point. */
  cpuPerMbps: number;
}

/**
 * Per-profile behaviour.
 *
 * These shape the TRAFFIC, not the arbitration. A URLLC slice is modelled as low-bandwidth,
 * latency-sensitive and bursty because that is how such traffic behaves — not because the
 * platform gives it priority. The arbitration engine never reads `profile`.
 */
export const PROFILE_CHARACTERISTICS: Readonly<Record<SliceProfile, ProfileCharacteristics>> =
  Object.freeze({
    [SliceProfile.URLLC]: {
      baseLatencyMs: 3,
      baseJitterMs: 0.4,
      meanLoadFactor: 0.55,
      loadVolatility: 0.12,
      burstProbability: 0.035,
      burstMagnitude: 2.1,
      burstDurationTicks: 8,
      sessionsPerMbps: 1.8,
      cpuPerMbps: 0.055,
    },
    [SliceProfile.EMBB]: {
      baseLatencyMs: 14,
      baseJitterMs: 2.2,
      meanLoadFactor: 0.72,
      loadVolatility: 0.18,
      burstProbability: 0.05,
      burstMagnitude: 1.7,
      burstDurationTicks: 16,
      sessionsPerMbps: 0.35,
      cpuPerMbps: 0.02,
    },
    [SliceProfile.MMTC]: {
      baseLatencyMs: 40,
      baseJitterMs: 6,
      meanLoadFactor: 0.42,
      loadVolatility: 0.08,
      burstProbability: 0.02,
      burstMagnitude: 3.2,
      burstDurationTicks: 6,
      sessionsPerMbps: 22,
      cpuPerMbps: 0.09,
    },
    [SliceProfile.V2X]: {
      baseLatencyMs: 6,
      baseJitterMs: 0.9,
      meanLoadFactor: 0.6,
      loadVolatility: 0.22,
      burstProbability: 0.06,
      burstMagnitude: 2.4,
      burstDurationTicks: 10,
      sessionsPerMbps: 3.1,
      cpuPerMbps: 0.04,
    },
  });

/* ------------------------------------------------------------------ */
/* Diurnal load curve                                                  */
/* ------------------------------------------------------------------ */

/**
 * Enterprise traffic multiplier by hour of day (local), 0–23.
 *
 * Modelled on a manufacturing/office site: a night-shift floor, a sharp 07:00 ramp, a
 * midday dip over lunch, a strong afternoon peak, and an evening decay. This is what
 * produces contention that arrives and clears on a realistic schedule rather than
 * uniformly at random — which in turn is what makes the fairness term observable, since
 * repeated contention events are what the burden rotates across.
 */
const DIURNAL_CURVE: readonly number[] = Object.freeze([
  0.32, 0.28, 0.26, 0.25, 0.27, 0.35, // 00–05 night shift
  0.52, 0.78, 0.94, 1.0, 1.02, 0.98, // 06–11 morning ramp and peak
  0.86, 0.93, 1.05, 1.08, 1.04, 0.9, // 12–17 lunch dip, afternoon peak
  0.74, 0.62, 0.54, 0.47, 0.4, 0.35, // 18–23 evening decay
]);

/** Smoothly interpolated diurnal multiplier — no discontinuity on the hour boundary. */
export function diurnalMultiplier(atMs: number): number {
  const date = new Date(atMs);
  const hour = date.getUTCHours();
  const fraction = (date.getUTCMinutes() * 60 + date.getUTCSeconds()) / 3600;
  const current = DIURNAL_CURVE[hour]!;
  const next = DIURNAL_CURVE[(hour + 1) % 24]!;
  return lerp(current, next, fraction);
}

/* ------------------------------------------------------------------ */
/* Per-slice simulation state                                          */
/* ------------------------------------------------------------------ */

/**
 * Mutable state carried between ticks.
 *
 * A memoryless generator would produce white noise, where consecutive samples are
 * unrelated. Real traffic is strongly autocorrelated — the load two seconds from now is
 * close to the load now. `loadWalk` provides that autocorrelation, and it is why the
 * capacity monitor's trend line and the contention detector's debounce logic have anything
 * meaningful to work with.
 */
export interface SliceSimulationState {
  sliceId: string;
  rng: RandomSource;
  /** Slow random walk around 1.0, giving traffic its autocorrelation. */
  loadWalk: number;
  /** Ticks remaining in the current burst; 0 when not bursting. */
  burstTicksRemaining: number;
  burstFactor: number;
  /** Smoothed CPU and memory, which lag throughput rather than tracking it instantly. */
  cpuPercent: number;
  memoryPercent: number;
  tick: number;
  /** Ticks remaining in an injected fault (see `injectFault`). */
  faultTicksRemaining: number;
  faultKind: FaultKind | null;
}

export const FaultKind = {
  /** Sustained demand surge — the classic capacity shortage. */
  DEMAND_SURGE: 'DEMAND_SURGE',
  /** Transport impairment: latency and loss rise without a demand change. */
  LINK_DEGRADATION: 'LINK_DEGRADATION',
  /** Compute saturation on the slice's user-plane function. */
  COMPUTE_SATURATION: 'COMPUTE_SATURATION',
} as const;
export type FaultKind = (typeof FaultKind)[keyof typeof FaultKind];

export function createSimulationState(
  sliceId: string,
  seed: number | undefined,
  profile: SliceProfile,
): SliceSimulationState {
  const rng = createRandom(seed ?? hashSeed(sliceId));
  const characteristics = PROFILE_CHARACTERISTICS[profile];

  return {
    sliceId,
    rng,
    // Start the walk at a plausible offset rather than exactly 1.0, so a fleet of slices
    // does not begin life perfectly synchronised.
    loadWalk: clamp(rng.normal(1, characteristics.loadVolatility), 0.35, 1.9),
    burstTicksRemaining: 0,
    burstFactor: 1,
    cpuPercent: rng.uniform(8, 22),
    memoryPercent: rng.uniform(20, 40),
    tick: 0,
    faultTicksRemaining: 0,
    faultKind: null,
  };
}

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

export interface TrafficInputs {
  profile: SliceProfile;
  baselineAllocatedMbps: number;
  allocatedMbps: number;
  maxBurstMbps: number;
  atMs: number;
  /** Global load multiplier, so an operator can drive the whole network into contention. */
  globalLoadMultiplier: number;
}

export interface TrafficOutputs {
  demandMbps: number;
  usedMbps: number;
  utilisation: number;
  latencyMs: number;
  jitterMs: number;
  packetLossPercent: number;
  cpuPercent: number;
  memoryPercent: number;
  activeSessions: number;
}

/** Utilisation beyond which the queueing term is capped, to keep latency finite. */
const MAX_MODELLED_UTILISATION = 0.985;

/**
 * Advance one slice by one tick and emit its observable metrics.
 *
 * Mutates `state` — this is a simulation step, and pretending otherwise by returning a new
 * state object would just add allocation churn at 2 Hz per slice for no benefit.
 */
export function stepTraffic(state: SliceSimulationState, inputs: TrafficInputs): TrafficOutputs {
  const characteristics = PROFILE_CHARACTERISTICS[inputs.profile];
  const { rng } = state;
  state.tick += 1;

  /* ---- 1. Demand -------------------------------------------------- */

  // Mean-reverting random walk (Ornstein–Uhlenbeck): pulled gently back toward 1.0 so it
  // wanders without drifting away permanently.
  const reversion = 0.06;
  state.loadWalk = clamp(
    state.loadWalk + reversion * (1 - state.loadWalk) + rng.normal(0, characteristics.loadVolatility * 0.35),
    0.3,
    2.2,
  );

  // Bursts arrive as a Bernoulli process and decay over a geometric duration.
  if (state.burstTicksRemaining > 0) {
    state.burstTicksRemaining -= 1;
    if (state.burstTicksRemaining === 0) state.burstFactor = 1;
  } else if (rng.chance(characteristics.burstProbability)) {
    state.burstTicksRemaining = Math.max(
      1,
      Math.round(rng.exponential(1 / characteristics.burstDurationTicks)),
    );
    state.burstFactor = lerp(1, characteristics.burstMagnitude, rng.next());
  }

  // Injected faults.
  if (state.faultTicksRemaining > 0) state.faultTicksRemaining -= 1;
  else state.faultKind = null;

  const faultDemandMultiplier =
    state.faultKind === FaultKind.DEMAND_SURGE ? 1.9 : 1;

  const demandMbps = Math.max(
    0,
    inputs.baselineAllocatedMbps *
      characteristics.meanLoadFactor *
      state.loadWalk *
      state.burstFactor *
      diurnalMultiplier(inputs.atMs) *
      inputs.globalLoadMultiplier *
      faultDemandMultiplier,
  );

  /* ---- 2. Throughput ---------------------------------------------- */

  // A slice cannot receive more than it is granted. This single line is what makes
  // degradation observable, and what makes demand > allocated a persistent signal rather
  // than one that erases itself.
  const allocated = Math.max(inputs.allocatedMbps, 0.001);
  const usedMbps = Math.min(demandMbps, allocated);
  const utilisation = usedMbps / allocated;

  /* ---- 3. Queueing delay ------------------------------------------ */

  // M/M/1 waiting time grows as 1/(1−ρ). This produces the characteristic knee: barely
  // any effect below 70 % utilisation, then a sharp climb. Capping ρ keeps the value
  // finite at saturation, where a real system would be dropping rather than queueing.
  const rho = clamp01(Math.min(utilisation, MAX_MODELLED_UTILISATION));
  const queueingFactor = 1 / (1 - rho);

  const linkPenalty = state.faultKind === FaultKind.LINK_DEGRADATION ? 3.4 : 1;

  const latencyMs = round(
    characteristics.baseLatencyMs *
      queueingFactor *
      linkPenalty *
      Math.max(0.6, rng.normal(1, 0.06)),
    3,
  );

  // Jitter tracks the same congestion signal but grows sub-linearly, matching the
  // observation that delay variation saturates before mean delay does.
  const jitterMs = round(
    characteristics.baseJitterMs *
      Math.sqrt(queueingFactor) *
      linkPenalty *
      Math.max(0.4, rng.normal(1, 0.15)),
    3,
  );

  /* ---- 4. Packet loss --------------------------------------------- */

  // Loss is OVERFLOW, not an independent variable. Below the allocation there is only a
  // small background rate; above it, the excess is dropped and loss is the drop ratio.
  const excess = Math.max(0, demandMbps - allocated);
  const overflowLoss = demandMbps > 0 ? (excess / demandMbps) * 100 : 0;
  const backgroundLoss = Math.max(0, rng.normal(0.015, 0.012)) * (state.faultKind === FaultKind.LINK_DEGRADATION ? 22 : 1);
  const packetLossPercent = round(clamp(overflowLoss + backgroundLoss, 0, 100), 4);

  /* ---- 5. Compute ------------------------------------------------- */

  const sessions = Math.max(0, Math.round(usedMbps * characteristics.sessionsPerMbps * rng.normal(1, 0.08)));

  // CPU and memory LAG throughput — a user-plane function does not change utilisation
  // instantaneously. Different smoothing constants stop them moving in lockstep, which
  // would look obviously synthetic on a dashboard.
  const cpuTarget = clamp(
    10 + usedMbps * characteristics.cpuPerMbps + (state.faultKind === FaultKind.COMPUTE_SATURATION ? 55 : 0),
    2,
    99,
  );
  state.cpuPercent = clamp(state.cpuPercent + 0.28 * (cpuTarget - state.cpuPercent) + rng.normal(0, 1.1), 1, 100);

  const memoryTarget = clamp(
    24 + sessions * 0.012 + (state.faultKind === FaultKind.COMPUTE_SATURATION ? 30 : 0),
    5,
    97,
  );
  state.memoryPercent = clamp(
    state.memoryPercent + 0.11 * (memoryTarget - state.memoryPercent) + rng.normal(0, 0.5),
    1,
    100,
  );

  return {
    demandMbps: round(demandMbps, 3),
    usedMbps: round(usedMbps, 3),
    utilisation: round(utilisation, 4),
    latencyMs,
    jitterMs,
    packetLossPercent,
    cpuPercent: round(state.cpuPercent, 2),
    memoryPercent: round(state.memoryPercent, 2),
    activeSessions: sessions,
  };
}

/**
 * Inject a fault for a number of ticks.
 *
 * Exposed through `POST /telemetry/inject` (MANAGER role) so an operator can drive the
 * platform into contention on demand — for a demo, a runbook rehearsal, or an end-to-end
 * test of the whole control loop. On a live network the equivalent operation is a traffic
 * generator, which is why this lives on the synthetic adapter rather than on the port.
 */
export function injectFault(
  state: SliceSimulationState,
  kind: FaultKind,
  durationTicks: number,
): void {
  state.faultKind = kind;
  state.faultTicksRemaining = Math.max(1, Math.round(durationTicks));
}

export function clearFault(state: SliceSimulationState): void {
  state.faultKind = null;
  state.faultTicksRemaining = 0;
}
