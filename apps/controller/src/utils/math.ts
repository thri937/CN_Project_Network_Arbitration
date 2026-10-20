/**
 * Numeric primitives shared by the domain engines.
 *
 * Everything here is a pure function with no dependency on config, logging or I/O, so the
 * domain layer can import it without violating the dependency rule.
 */

/** Constrain `value` to `[min, max]`. NaN-safe: returns `min` for NaN input. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Linear interpolation. `t` is clamped to [0,1]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/**
 * Map `value` from `[inMin, inMax]` onto `[outMin, outMax]`, clamped at both ends.
 * Returns `outMin` for a degenerate input range rather than dividing by zero.
 */
export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (inMax === inMin) return outMin;
  const t = clamp01((value - inMin) / (inMax - inMin));
  return outMin + (outMax - outMin) * t;
}

/** Round to `decimals` places using half-away-from-zero, avoiding float artefacts. */
export function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

/** Safe division: returns `fallback` instead of Infinity/NaN when the divisor is ~0. */
export function safeDivide(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return fallback;
  if (Math.abs(denominator) < Number.EPSILON) return fallback;
  return numerator / denominator;
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / (values.length - 1));
}

/**
 * Nearest-rank percentile (P50/P95/P99 for SLA reporting).
 * @param p percentile in [0,100]
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((clamp(p, 0, 100) / 100) * sorted.length);
  return sorted[clamp(rank - 1, 0, sorted.length - 1)]!;
}

/** Exponentially weighted moving average. `alpha` ∈ (0,1]; higher = more reactive. */
export function ewma(previous: number | null, sample: number, alpha: number): number {
  if (previous === null || !Number.isFinite(previous)) return sample;
  const a = clamp01(alpha);
  return a * sample + (1 - a) * previous;
}

/**
 * Least-squares slope of `values` against their index. Used by the capacity monitor to
 * report whether utilisation is trending up or down over the sample window.
 */
export function linearTrend(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xMean;
    numerator += dx * (values[i]! - yMean);
    denominator += dx * dx;
  }
  return safeDivide(numerator, denominator, 0);
}

/**
 * Logarithmic normalisation of an unbounded positive quantity onto [0,100].
 *
 * `reference` maps to 50. One order of magnitude above `reference` maps to ~75, two to
 * ~87.5, and so on — asymptotically approaching 100 without ever reaching it. This keeps a
 * single extreme outlier (a department claiming $10M/minute downtime cost) from saturating
 * the score and flattening every other input to irrelevance.
 */
export function logNormalise(value: number, reference: number, base = 10): number {
  if (value <= 0 || reference <= 0) return 0;
  const decades = Math.log(value / reference) / Math.log(base);
  // Logistic squash centred on 0 decades → 50.
  return clamp(100 / (1 + Math.exp(-decades)), 0, 100);
}

/** Sum of an object's numeric values. Used for weight-vector validation. */
export function sumValues(record: Readonly<Record<string, number>>): number {
  return sum(Object.values(record));
}

/**
 * Normalise a weight record so its values sum to 1. Returns a uniform distribution if the
 * input sums to zero, which is the only sane fallback for a misconfigured policy.
 */
export function normaliseWeights<K extends string>(
  weights: Readonly<Record<K, number>>,
): Record<K, number> {
  const keys = Object.keys(weights) as K[];
  const total = sumValues(weights as Record<string, number>);
  const out = {} as Record<K, number>;
  if (total <= 0) {
    for (const k of keys) out[k] = keys.length === 0 ? 0 : 1 / keys.length;
    return out;
  }
  for (const k of keys) out[k] = weights[k] / total;
  return out;
}

/** True when two floats agree to within `epsilon`. Never compare money/bandwidth with `===`. */
export function approxEqual(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon;
}
