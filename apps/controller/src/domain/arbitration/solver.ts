import { ArbitrationTunables } from '@/constants/tunables';
import { clamp01, round } from '@/utils/math';
import { buildHarmContext, harmAt, marginalHarm, meanBurdenOf, type HarmContext } from './harm';
import type { ArbitrationCandidate, ArbitrationSettingsInput } from './types';

/**
 * MARGINAL-HARM WATER-FILLING SOLVER
 * ==================================
 * Solves: minimise Σ H_i(d_i) subject to Σ (freed bandwidth) ≥ required, 0 ≤ d_i ≤ max_i.
 *
 * THE ALGORITHM
 * -------------
 * Repeatedly hand the next quantum of degradation to whichever slice currently has the
 * LOWEST marginal harm per Mbps freed, (dH/dd) / baseline, then re-evaluate. Stop when
 * enough bandwidth is freed or every slice has reached its ceiling.
 *
 * Per Mbps, not per unit of depth: every quantum removes the same number of Mbps, which is
 * a smaller depth on a larger slice. Ranking on dH/dd alone ignores slice size, and on a
 * fleet of unequal slices settles on a plan up to twice the optimal harm — independent of
 * the quantum, so no step size fixes it.
 *
 * WHY GREEDY IS OPTIMAL HERE (and not merely a heuristic)
 * ------------------------------------------------------
 * Each H_i is convex and increasing on [0, max_i] (γ ≥ 1), and the constraint is a single
 * linear budget Σ baseline_i · d_i ≥ required. That makes this a separable convex program,
 * whose KKT conditions state that at the optimum every slice with an interior solution has
 * EQUAL marginal harm per Mbps (dH_i/dd_i = μ · baseline_i), and every slice at a boundary
 * has marginal harm per Mbps no lower than that common value.
 *
 * Always spending the next unit where it is currently cheapest drives the marginal harms
 * of all active slices toward one another — it is precisely the iterative construction of
 * that KKT condition. The result is the true optimum up to the quantum size, not an
 * approximation of unknown quality. This is the same structure as water-filling in power
 * allocation, which is where the name comes from.
 *
 * WHY NOT A PROPER SOLVER
 * -----------------------
 * A general convex solver would give the exact continuous optimum. It is rejected because:
 *   • this runs every two seconds inside a control loop, and must finish in single-digit ms
 *   • the greedy path is EXPLAINABLE — every quantum has a recorded reason, so an operator
 *     can be shown exactly why the 47th quantum went to Warehouse rather than Facilities.
 *     "The solver's dual variables converged" is not an explanation anyone can act on.
 *   • an off-the-shelf solver is a substantial dependency inside the most safety-relevant
 *     path in the system
 *
 * The quantum is 0.5 % of demand by default, so the gap to the continuous optimum is
 * bounded by well under one percent of one slice's allocation.
 */

export interface SolverInput {
  candidates: ArbitrationCandidate[];
  requiredReductionMbps: number;
  settings: ArbitrationSettingsInput;
  /** Assumed hold time, used by the recovery-urgency multiplier. */
  assumedDurationSeconds: number;
}

export interface SolvedSlice {
  candidate: ArbitrationCandidate;
  context: HarmContext;
  /** Final degradation depth as a fraction of baseline. */
  depth: number;
  reductionMbps: number;
  newAllocationMbps: number;
  harm: number;
  marginalHarmAtStop: number;
  /** Ceiling in Mbps this slice could have contributed. */
  headroomMbps: number;
  /** Excluded from degradation entirely (compliance floor or zero ceiling). */
  exempt: boolean;
}

export interface SolverResult {
  slices: SolvedSlice[];
  achievedReductionMbps: number;
  totalHarm: number;
  iterations: number;
  converged: boolean;
  quantumMbps: number;
  eligibleCount: number;
  /** True when the deficit could not be fully cleared. */
  shortfall: number;
}

/**
 * Run the solver.
 *
 * Pure: no clock, no I/O, no mutation of the input. Given identical inputs it returns an
 * identical plan, which is what makes a recorded decision replayable.
 */
export function solve(input: SolverInput): SolverResult {
  const { candidates, settings } = input;
  const meanBurden = meanBurdenOf(candidates);

  /* ---- 1. Build working state -------------------------------------- */

  const working = candidates.map((candidate) => {
    const context = buildHarmContext(
      candidate,
      settings,
      meanBurden,
      input.assumedDurationSeconds,
    );

    // Headroom is the traffic the slice can shed before hitting the tighter of the policy
    // ceiling and the contractual floor — measured from what it is carrying, not from its
    // limit. Both bounds are hard, including across passes.
    const headroomMbps = sheddableMbps(candidate);

    return {
      candidate,
      context,
      headroomMbps,
      // Depth already applied by a previous arbitration pass, so a second pass during the
      // same contention continues up the harm curve instead of restarting at zero.
      depth: clamp01(
        1 - candidate.allocatedMbps / Math.max(candidate.baselineAllocatedMbps, 1e-9),
      ),
      reductionMbps: 0,
      exempt: context.maxDepth <= 0 || headroomMbps <= 0,
    };
  });

  const eligible = working.filter((w) => !w.exempt);

  /* ---- 2. Quantum sizing ------------------------------------------- */

  // Sized off total demand so the step is meaningful at any network scale, and floored so
  // a tiny network cannot produce a zero-sized quantum and loop forever.
  const totalDemand = candidates.reduce((sum, c) => sum + c.demandMbps, 0);
  const quantumMbps = Math.max(
    totalDemand * settings.degradationQuantum,
    0.01,
  );

  /* ---- 3. Water-fill ------------------------------------------------ */

  let achieved = 0;
  let iterations = 0;
  const maxIterations = ArbitrationTunables.MAX_ALLOCATION_ITERATIONS;

  while (achieved < input.requiredReductionMbps && iterations < maxIterations) {
    iterations += 1;

    // Cheapest next quantum across every slice with headroom remaining.
    let best: (typeof working)[number] | null = null;
    let bestMarginal = Number.POSITIVE_INFINITY;

    for (const slice of eligible) {
      const remaining = slice.headroomMbps - slice.reductionMbps;
      if (remaining <= 1e-9) continue;

      const marginal = marginalHarmPerMbps(slice, quantumMbps);

      // Strict `<` keeps the FIRST slice on ties, and `eligible` preserves the caller's
      // ordering — so equal candidates resolve deterministically rather than by chance.
      if (marginal < bestMarginal) {
        bestMarginal = marginal;
        best = slice;
      }
    }

    // Every slice is at its ceiling: the deficit cannot be fully cleared.
    if (!best) break;

    const remaining = best.headroomMbps - best.reductionMbps;
    const step = Math.min(
      quantumMbps,
      remaining,
      // Never overshoot the requirement — degrading more than necessary is pure harm.
      input.requiredReductionMbps - achieved,
    );

    if (step <= 1e-9) break;

    best.reductionMbps += step;
    best.depth = clamp01(
      best.reductionMbps / Math.max(best.candidate.baselineAllocatedMbps, 1e-9) +
        (1 - best.candidate.allocatedMbps / Math.max(best.candidate.baselineAllocatedMbps, 1e-9)),
    );
    achieved += step;
  }

  /* ---- 4. Materialise ----------------------------------------------- */

  const slices: SolvedSlice[] = working.map((slice) => {
    // A degraded slice's new limit sits below what it is carrying, so the cut sheds real
    // traffic; any allowance above that it wasn't using is released at no harm. Untouched
    // slices keep their limit.
    const newAllocation =
      slice.reductionMbps > 1e-9
        ? Math.max(
            slice.candidate.minGuaranteedMbps,
            carriedMbps(slice.candidate) - slice.reductionMbps,
          )
        : slice.candidate.allocatedMbps;

    return {
      candidate: slice.candidate,
      context: slice.context,
      depth: round(slice.depth, 6),
      reductionMbps: round(slice.reductionMbps, 4),
      newAllocationMbps: round(newAllocation, 4),
      harm: round(harmAt(slice.context, slice.depth), 6),
      marginalHarmAtStop: slice.exempt
        ? Number.POSITIVE_INFINITY
        : round(marginalHarmPerMbps(slice, quantumMbps), 6),
      headroomMbps: round(slice.headroomMbps, 4),
      exempt: slice.exempt,
    };
  });

  return {
    slices,
    achievedReductionMbps: round(achieved, 4),
    totalHarm: round(
      slices.reduce((sum, s) => sum + (Number.isFinite(s.harm) ? s.harm : 0), 0),
      6,
    ),
    iterations,
    converged: iterations < maxIterations,
    quantumMbps: round(quantumMbps, 4),
    eligibleCount: eligible.length,
    shortfall: round(Math.max(0, input.requiredReductionMbps - achieved), 4),
  };
}

/**
 * Traffic a slice is actually passing: it cannot send more than it asks for, nor more than
 * its current limit. Lowering a limit only sheds traffic below this figure.
 */
export function carriedMbps(candidate: ArbitrationCandidate): number {
  return Math.max(0, Math.min(candidate.demandMbps, candidate.allocatedMbps));
}

/**
 * Traffic that may be shed from a slice: down to the tighter of its contractual floor and
 * the lowest limit its policy ceiling allows, baseline × (1 − max depth). Measured from what
 * the slice carries — cutting a limit it isn't using frees nothing on the network — and the
 * ceiling holds across passes, because an already-degraded slice carries less.
 */
export function sheddableMbps(candidate: ArbitrationCandidate): number {
  const maxDepth = clamp01(candidate.maxDegradationPercent / 100);
  const lowestLimit = Math.max(
    candidate.minGuaranteedMbps,
    candidate.baselineAllocatedMbps * (1 - maxDepth),
  );
  return Math.max(0, carriedMbps(candidate) - lowestLimit);
}

/**
 * Marginal harm of the next quantum, per Mbps freed. A quantum of q Mbps is a depth step of
 * q / baseline on this slice, so dividing dH/dd by the baseline puts slices of different
 * sizes on the common scale the KKT condition is stated in.
 */
function marginalHarmPerMbps(
  slice: { candidate: ArbitrationCandidate; context: HarmContext; depth: number },
  quantumMbps: number,
): number {
  const baseline = Math.max(slice.candidate.baselineAllocatedMbps, 1e-9);
  return marginalHarm(slice.context, slice.depth, quantumMbps / baseline) / baseline;
}

/**
 * Total harm of an arbitrary degradation assignment.
 *
 * Used to price the counterfactual strategies in `alternatives.ts` on exactly the same
 * scale as the chosen plan. Comparing plans computed by different code paths would make
 * the "we considered these and rejected them" claim unverifiable.
 *
 * Every candidate is priced, not only those the assignment touches: on a second pass during
 * the same contention a slice may already carry depth from the first, and `solve` counts
 * that harm whether or not it cuts the slice again. Skipping untouched slices here made a
 * counterfactual look cheaper than an IDENTICAL chosen plan.
 */
export function priceAssignment(
  candidates: readonly ArbitrationCandidate[],
  reductions: ReadonlyMap<string, number>,
  settings: ArbitrationSettingsInput,
  assumedDurationSeconds: number,
): { totalHarm: number; achievedReductionMbps: number } {
  const meanBurden = meanBurdenOf(candidates);
  let totalHarm = 0;
  let achieved = 0;

  for (const candidate of candidates) {
    const reduction = Math.max(0, reductions.get(candidate.sliceId) ?? 0);

    const context = buildHarmContext(candidate, settings, meanBurden, assumedDurationSeconds);
    const alreadyDegraded =
      1 - candidate.allocatedMbps / Math.max(candidate.baselineAllocatedMbps, 1e-9);
    const depth = clamp01(
      alreadyDegraded + reduction / Math.max(candidate.baselineAllocatedMbps, 1e-9),
    );

    const harm = harmAt(context, depth);
    totalHarm += Number.isFinite(harm) ? harm : 0;
    achieved += reduction;
  }

  return { totalHarm: round(totalHarm, 6), achievedReductionMbps: round(achieved, 4) };
}
