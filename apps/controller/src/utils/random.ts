/**
 * Deterministic pseudo-random number generation.
 *
 * The synthetic telemetry engine must be *reproducible*: given the same seed and the same
 * tick count it must emit the same metric stream. That is what makes it possible to replay
 * a contention scenario against a modified arbitration algorithm and compare outcomes —
 * which is the difference between an engineering tool and a lava lamp.
 *
 * `Math.random()` is deliberately never used anywhere in the telemetry or domain layers.
 */

export interface RandomSource {
  /** Uniform in [0,1). */
  next(): number;
  /** Uniform in [min, max). */
  uniform(min: number, max: number): number;
  /**
   * Standard-normal sample scaled to the given mean and standard deviation.
   * Consumes exactly two uniforms per call — see the implementation note on Box–Muller.
   */
  normal(mean: number, stdDev: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** Uniformly pick one element; throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** Exponential distribution with the given rate (λ). Models inter-arrival times. */
  exponential(rate: number): number;
  /** Current internal state, for snapshotting a reproducible run. */
  getState(): number;
  setState(state: number): void;
}

/**
 * mulberry32 — 32-bit state, period 2^32, excellent statistical quality for simulation
 * work, and about 20× faster than a cryptographic source. Not suitable for security use;
 * we use `node:crypto` for anything that matters (see `utils/ids.ts`).
 */
export function createRandom(seed: number): RandomSource {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /**
   * Box–Muller transform.
   *
   * The textbook implementation caches the second of the two normals it produces and
   * returns it on the next call. We deliberately DISCARD it. Caching would put part of the
   * generator's state outside `state`, which breaks the snapshot/restore contract:
   * `setState(getState())` would no longer reproduce the stream when the checkpoint landed
   * between a paired call. Discarding the spare costs one extra `next()` per sample and
   * buys the invariant that N normal draws always consume exactly 2N uniforms — so a
   * telemetry run can be replayed exactly from a single 32-bit number.
   */
  const normal = (mean: number, stdDev: number): number => {
    let u = 0;
    let v = 0;
    // Reject exact zero: log(0) is -Infinity.
    while (u === 0) u = next();
    while (v === 0) v = next();
    const radius = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    return mean + stdDev * radius * Math.cos(theta);
  };

  return {
    next,
    uniform: (min, max) => min + next() * (max - min),
    normal,
    chance: (p) => next() < p,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('pick() called on an empty array');
      return items[Math.floor(next() * items.length)]!;
    },
    exponential: (rate) => (rate <= 0 ? 0 : -Math.log(1 - next()) / rate),
    getState: () => state,
    setState: (s) => {
      state = s >>> 0;
    },
  };
}

/** Stable 32-bit hash — turns a slice id into a reproducible per-slice seed. */
export function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
