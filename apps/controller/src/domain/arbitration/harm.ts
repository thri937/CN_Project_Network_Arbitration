import { clamp, clamp01, round, safeDivide } from '@/utils/math';
import type { ArbitrationCandidate, ArbitrationSettingsInput } from './types';

/**
 * THE HARM MODEL
 * ==============
 * The mathematical core of CBHA. Everything the arbitration engine decides follows from
 * this function and the shape of its derivative.
 *
 *   H_i(d_i) = BPS_i · (d_i / max_i)^γ_i · (1 + g·stress_i) · fairness_i · urgency_i
 *
 * where d_i is the degradation depth as a fraction of the slice's baseline allocation.
 *
 * WHY THIS IS NOT A SORT
 * ======================
 * The obvious algorithm is: rank slices by priority, degrade the lowest until the deficit
 * clears. That is what a QoS scheduler does, and it has a specific pathology — it takes
 * EVERYTHING from one victim before touching anyone else. A department that happens to sit
 * at the bottom of the ranking absorbs a 60 % cut while five departments one rank above it
 * are untouched.
 *
 * The exponent γ changes the answer. Because H is superlinear (γ > 1), the harm of the
 * fortieth percent of degradation is far greater than the harm of the fifth. Concretely,
 * for γ = 2.2 the marginal cost of degradation at depth 0.4 is about 15× the marginal cost
 * at depth 0.05. So after a few percent have been taken from the cheapest slice, the NEXT
 * percent from it costs more than the FIRST percent from a slice ranked well above it —
 * and the optimiser switches. The result is many shallow cuts rather than one deep one.
 *
 * γ is not a tuning knob invented for the effect. It comes from recovery tolerance, which
 * is a business fact: a department that cannot tolerate degradation at all (γ = 3.0) has
 * harm that explodes with depth, so the engine will take 2 % from it and no more. A
 * department that tolerates degradation well (γ = 1.15) has near-linear harm and can absorb
 * a deep cut without the optimiser objecting.
 *
 * CONVEXITY IS WHAT MAKES THE GREEDY SOLVER OPTIMAL
 * =================================================
 * For γ ≥ 1 each H_i is convex and increasing on [0, max_i]. Minimising Σ H_i subject to a
 * single linear capacity constraint is then a separable convex program, and its KKT
 * conditions state that at the optimum every slice being degraded has EQUAL marginal harm.
 * That is exactly what water-filling on dH/dd converges to — see `solver.ts`.
 */

/* ------------------------------------------------------------------ */
/* Multipliers                                                         */
/* ------------------------------------------------------------------ */

/**
 * SLA stress amplification.
 *
 * A slice already consuming 90 % of its latency budget is a more damaging place to take
 * bandwidth from than one sitting at 20 %, even at identical business priority — the first
 * will breach almost immediately, the second has room. Multiplier ∈ [1, 1+g].
 */
export function slaStressMultiplier(stress: number, gain: number): number {
  return 1 + Math.max(0, gain) * clamp01(stress);
}

/**
 * HISTORICAL FAIRNESS — what stops the same slice being degraded every single time.
 *
 * Without it the engine is memoryless: identical inputs give identical outputs, so the
 * unluckiest slice is chosen again on every contention event, for weeks. Its department
 * experiences the platform as persecution, and they are right to.
 *
 * Harm is multiplied by `1 + λ·(relativeBurden − 1)`, where relativeBurden is this slice's
 * accumulated degradation burden divided by the fleet mean. A slice that has absorbed twice
 * the average recently becomes ~λ more expensive to degrade again, so the optimiser prefers
 * someone else — until the burden evens out and it becomes eligible once more.
 *
 * Bounded to [1/(1+λ), 1+λ] so fairness NUDGES the outcome and can never override a hard
 * constraint or invert a large business-priority gap. Rotating the burden is desirable;
 * degrading a hospital because a warehouse had a bad week is not.
 */
export function fairnessMultiplier(
  burdenScore: number,
  meanBurden: number,
  lambda: number,
): number {
  if (lambda <= 0) return 1;

  // With no history anywhere, every slice is equally (un)burdened.
  if (meanBurden <= 0) return 1;

  const relative = safeDivide(burdenScore, meanBurden, 1);
  const raw = 1 + lambda * (relative - 1);

  return clamp(raw, 1 / (1 + lambda), 1 + lambda);
}

/**
 * RECOVERY-INTOLERANCE SCALE — the fix for a subtle but serious modelling error.
 *
 * The original design expressed recovery intolerance ONLY through the curvature γ, on the
 * reasoning that "an intolerant department's harm should explode with depth". That is true
 * of the curve's shape and completely wrong in its consequences, which the engine's own
 * test suite caught:
 *
 *   For H ∝ (d/max)^γ, a LARGER γ makes the curve start FLATTER. The marginal harm of the
 *   first few percent is therefore LOWER for an intolerant department than for a tolerant
 *   one. Water-filling spends where marginal harm is lowest, so the zero-tolerance
 *   department was being cut FIRST and DEEPEST — precisely backwards.
 *
 * Curvature and level are two different properties and both are real:
 *
 *   curvature (γ)  how fast harm accelerates as the cut deepens
 *   level (this)   how much a given cut hurts at all
 *
 * A department that cannot tolerate degradation has BOTH: any cut hurts it more, and each
 * further percent hurts disproportionately more again. Scaling harm by intolerance restores
 * the intended ordering while keeping the convexity that spreads cuts across slices.
 *
 * Returns ~2.5 for ZERO tolerance and ~1.2 for HIGH.
 */
export function intoleranceScale(intoleranceScore: number): number {
  return 1 + 1.5 * clamp01(intoleranceScore / 100);
}

/**
 * Recovery urgency.
 *
 * Converts money into the harm scale. A department losing £8,400/minute accrues damage
 * roughly 84× faster than one losing £100/minute, and a plan holding the first degraded for
 * ten minutes is materially worse than one holding the second for the same period — even at
 * equal business-priority scores, because the score already log-compressed that cost.
 *
 * Compressed with a square root over the reference ratio: `downtimeCost` is ALREADY a
 * weighted term inside the business priority score, and applying its full linear force
 * again here would double-count it and let cost dominate a second time through the back
 * door. The square root retains the ordering while damping the magnitude.
 */
export function recoveryUrgency(
  downtimeCostPerMinute: number,
  durationSeconds: number,
  reference: number,
): number {
  if (downtimeCostPerMinute <= 0 || reference <= 0) return 1;

  const costRatio = downtimeCostPerMinute / reference;
  const minutes = Math.max(0, durationSeconds) / 60;

  // 1 + √(costRatio) · (minutes / 10): a ten-minute hold at the reference cost adds ~1.0.
  return 1 + Math.sqrt(costRatio) * (minutes / 10);
}

/* ------------------------------------------------------------------ */
/* Harm                                                                */
/* ------------------------------------------------------------------ */

/** Everything about a candidate that the harm function needs, precomputed once per run. */
export interface HarmContext {
  /** Business priority, 0–100. */
  businessScore: number;
  /** γ — harm curvature from recovery tolerance. */
  curvature: number;
  /** Maximum degradation depth as a fraction of baseline, (0,1]. */
  maxDepth: number;
  /** Product of the SLA, fairness and urgency multipliers. */
  multiplier: number;
  /** Component multipliers, retained for the explanation. */
  components: {
    slaStress: number;
    fairness: number;
    urgency: number;
    intolerance: number;
  };
}

/**
 * Total harm of degrading a slice to depth `d` (a fraction of baseline).
 *
 * `d` is normalised against `maxDepth` before exponentiation, so the curve always spans
 * 0→1 over the slice's own permitted range. Without that normalisation a department with a
 * 5 % ceiling and one with a 60 % ceiling would sit on completely different parts of the
 * curve and their harms would not be comparable — which is the only thing the optimiser
 * does with them.
 */
export function harmAt(context: HarmContext, depth: number): number {
  if (context.maxDepth <= 0) return Number.POSITIVE_INFINITY;
  if (depth <= 0) return 0;

  const normalised = clamp01(depth / context.maxDepth);
  return context.businessScore * normalised ** context.curvature * context.multiplier;
}

/**
 * Marginal harm — dH/dd at depth `d`. The quantity the water-filling solver ranks on.
 *
 *   dH/dd = BPS · multiplier · γ · d^(γ−1) / maxDepth^γ
 *
 * Strictly increasing in `d` for γ > 1, which is the convexity the greedy algorithm's
 * optimality depends on.
 *
 * At exactly d = 0 with γ > 1 the true derivative is zero, meaning the first infinitesimal
 * slice of degradation is free. That is mathematically correct but operationally useless —
 * it would make the solver split the first quantum across every eligible slice, touching
 * dozens of departments to save a few Mbps, when a NOC would far rather see three slices
 * degraded than thirty. Evaluating the derivative at the MIDPOINT of the quantum about to
 * be allocated fixes this: it is both a better numerical estimate of the quantum's average
 * cost and it prices the first quantum honestly.
 */
export function marginalHarm(context: HarmContext, depth: number, quantum: number): number {
  if (context.maxDepth <= 0) return Number.POSITIVE_INFINITY;

  // Midpoint of the quantum under consideration.
  const evaluationDepth = clamp(depth + quantum / 2, 0, context.maxDepth);
  const normalised = clamp01(evaluationDepth / context.maxDepth);

  return (
    (context.businessScore *
      context.multiplier *
      context.curvature *
      normalised ** (context.curvature - 1)) /
    context.maxDepth
  );
}

/**
 * Build the harm context for one candidate.
 *
 * `meanBurden` is a fleet-wide statistic, so it is computed once by the caller and passed
 * in — recomputing it per candidate would be O(n²) and, worse, would let it drift between
 * candidates within a single run.
 */
export function buildHarmContext(
  candidate: ArbitrationCandidate,
  settings: ArbitrationSettingsInput,
  meanBurden: number,
  assumedDurationSeconds: number,
): HarmContext {
  const maxDepth = clamp01(candidate.maxDegradationPercent / 100);

  const sla = slaStressMultiplier(candidate.slaStress, settings.slaStressGain);
  const fairness = fairnessMultiplier(
    candidate.burdenScore,
    meanBurden,
    settings.fairnessLambda,
  );
  const urgency = recoveryUrgency(
    candidate.downtimeCostPerMinute,
    assumedDurationSeconds,
    settings.downtimeCostReference,
  );
  const intolerance = intoleranceScale(candidate.recoveryIntoleranceScore);

  return {
    businessScore: Math.max(candidate.priority.score, 0.01), // avoid a zero-harm slice
    curvature: Math.max(candidate.harmCurvature, 1),
    maxDepth,
    multiplier: sla * fairness * urgency * intolerance,
    components: {
      slaStress: round(sla, 4),
      fairness: round(fairness, 4),
      urgency: round(urgency, 4),
      intolerance: round(intolerance, 4),
    },
  };
}

/**
 * Mean burden across candidates that have any history.
 *
 * Slices with zero burden are EXCLUDED from the mean. Including them would drag it toward
 * zero, inflating every non-zero slice's relative burden and making the fairness term fire
 * hard on the first ever degradation — the opposite of its purpose.
 */
export function meanBurdenOf(candidates: readonly ArbitrationCandidate[]): number {
  const withHistory = candidates.filter((c) => c.burdenScore > 0);
  if (withHistory.length === 0) return 0;
  return withHistory.reduce((sum, c) => sum + c.burdenScore, 0) / withHistory.length;
}
