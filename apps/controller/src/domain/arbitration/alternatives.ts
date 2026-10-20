import { round, safeDivide } from '@/utils/math';
import { priceAssignment, sheddableMbps } from './solver';
import type { AlternativePlan, ArbitrationCandidate, ArbitrationSettingsInput } from './types';

/**
 * COUNTERFACTUAL STRATEGIES
 * =========================
 * The specification requires each decision to record "alternative options". Recording an
 * empty list, or a list of plans nobody would ever propose, would satisfy the letter and
 * miss the point.
 *
 * These are the strategies a reasonable engineer would ACTUALLY argue for in a review, each
 * priced on the identical harm scale as the chosen plan. That is what turns "the algorithm
 * decided" into "here is what we considered and here is why it was worse" — which is the
 * only form of explanation that survives a department head asking why their slice was cut.
 *
 * `PRIORITY_SORT` is the most important of the four: it is what a conventional QoS-based
 * controller does. Pricing it alongside the chosen plan on every single decision produces a
 * continuous, auditable record of how much business harm this platform is avoiding relative
 * to the approach it replaces.
 */

export interface AlternativeContext {
  candidates: ArbitrationCandidate[];
  requiredReductionMbps: number;
  settings: ArbitrationSettingsInput;
  assumedDurationSeconds: number;
  /** Harm of the plan actually chosen, for the penalty comparison. */
  chosenHarm: number;
  chosenAchievedMbps: number;
}

/** Traffic a candidate can shed — the same bound the chosen plan is held to. */
const headroomOf = (candidate: ArbitrationCandidate): number => sheddableMbps(candidate);

export function evaluateAlternatives(context: AlternativeContext): AlternativePlan[] {
  const strategies = [
    prioritySortStrategy,
    uniformCutStrategy,
    singleVictimStrategy,
    protectStressedStrategy,
  ];

  return strategies
    .map((strategy) => strategy(context))
    .filter((plan): plan is AlternativePlan => plan !== null)
    .sort((a, b) => a.totalHarm - b.totalHarm);
}

/* ------------------------------------------------------------------ */

/**
 * STRATEGY: PRIORITY SORT — what a conventional controller does.
 *
 * Rank by business priority ascending; degrade the lowest-ranked slice to its ceiling,
 * then the next, until the deficit clears. No convexity, no fairness, no SLA awareness —
 * exactly the "generic priority-based degradation" this platform exists to replace.
 *
 * This is the benchmark. The harm gap between it and the chosen plan is the platform's
 * quantified value, recorded on every decision.
 */
function prioritySortStrategy(context: AlternativeContext): AlternativePlan | null {
  const ordered = [...context.candidates]
    .filter((c) => headroomOf(c) > 0)
    .sort((a, b) => {
      if (a.priority.score !== b.priority.score) return a.priority.score - b.priority.score;
      return a.sliceId.localeCompare(b.sliceId);
    });

  if (ordered.length === 0) return null;

  const reductions = new Map<string, number>();
  let remaining = context.requiredReductionMbps;
  let affected = 0;

  for (const candidate of ordered) {
    if (remaining <= 1e-9) break;
    const take = Math.min(headroomOf(candidate), remaining);
    if (take <= 1e-9) continue;
    reductions.set(candidate.sliceId, take);
    remaining -= take;
    affected += 1;
  }

  const priced = priceAssignment(
    context.candidates,
    reductions,
    context.settings,
    context.assumedDurationSeconds,
  );

  const deepest = [...reductions.entries()].reduce(
    (worst, [sliceId, mbps]) => {
      const candidate = context.candidates.find((c) => c.sliceId === sliceId);
      if (!candidate) return worst;
      const percent = (mbps / Math.max(candidate.baselineAllocatedMbps, 1e-9)) * 100;
      return percent > worst.percent ? { name: candidate.sliceName, percent } : worst;
    },
    { name: '', percent: 0 },
  );

  return {
    strategy: 'PRIORITY_SORT',
    description:
      'Rank slices by business priority and degrade the lowest-ranked to its ceiling before ' +
      'touching the next — the conventional QoS-style approach.',
    totalHarm: priced.totalHarm,
    harmPenaltyPercent: penaltyOf(priced.totalHarm, context.chosenHarm, remaining <= 1e-6),
    feasible: remaining <= 1e-6,
    achievedReductionMbps: priced.achievedReductionMbps,
    affectedSliceCount: affected,
    rejectedBecause:
      deepest.percent > 0
        ? `Concentrates the entire reduction on the lowest-ranked slices, cutting ` +
          `${deepest.name} by ${round(deepest.percent, 1)}%. Because harm rises superlinearly with ` +
          `depth, one deep cut costs more than the same total spread shallowly.`
        : 'No slice had degradable headroom under this strategy.',
  };
}

/**
 * STRATEGY: UNIFORM CUT — "everyone shares the pain equally".
 *
 * Politically appealing and superficially fair. It is rejected because it is blind to
 * business context: it takes the same percentage from a life-safety slice as from digital
 * signage. Pricing it explicitly is worth doing precisely BECAUSE it is the strategy
 * stakeholders most often propose.
 */
function uniformCutStrategy(context: AlternativeContext): AlternativePlan | null {
  const eligible = context.candidates.filter((c) => headroomOf(c) > 0);
  if (eligible.length === 0) return null;

  const totalHeadroom = eligible.reduce((sum, c) => sum + headroomOf(c), 0);
  if (totalHeadroom <= 0) return null;

  // Proportional to headroom, which is the fairest reading of "equal share".
  const fraction = Math.min(1, context.requiredReductionMbps / totalHeadroom);
  const reductions = new Map<string, number>();

  for (const candidate of eligible) {
    const take = headroomOf(candidate) * fraction;
    if (take > 1e-9) reductions.set(candidate.sliceId, take);
  }

  const priced = priceAssignment(
    context.candidates,
    reductions,
    context.settings,
    context.assumedDurationSeconds,
  );

  const highestPriority = [...eligible].sort((a, b) => b.priority.score - a.priority.score)[0]!;

  return {
    strategy: 'UNIFORM_CUT',
    description:
      'Reduce every eligible slice by the same proportion of its available headroom, ' +
      'irrespective of business context.',
    totalHarm: priced.totalHarm,
    harmPenaltyPercent: penaltyOf(priced.totalHarm, context.chosenHarm, fraction < 1),
    feasible: fraction < 1,
    achievedReductionMbps: priced.achievedReductionMbps,
    affectedSliceCount: reductions.size,
    rejectedBecause:
      `Degrades all ${reductions.size} eligible slices, including ${highestPriority.sliceName} ` +
      `(business score ${round(highestPriority.priority.score, 1)}), which the chosen plan protects. ` +
      `Treating every department identically discards the business context the platform exists to apply.`,
  };
}

/**
 * STRATEGY: SINGLE VICTIM — take everything from the single cheapest slice.
 *
 * Minimises the NUMBER of affected departments, which has real operational appeal: one
 * conversation instead of six. Priced so that appeal can be weighed rather than asserted.
 */
function singleVictimStrategy(context: AlternativeContext): AlternativePlan | null {
  const eligible = context.candidates.filter((c) => headroomOf(c) > 0);
  if (eligible.length === 0) return null;

  const victim = [...eligible].sort((a, b) => {
    const byHeadroom = headroomOf(b) - headroomOf(a);
    if (Math.abs(byHeadroom) > 1e-6) return byHeadroom;
    return a.priority.score - b.priority.score;
  })[0]!;

  const take = Math.min(headroomOf(victim), context.requiredReductionMbps);
  const reductions = new Map([[victim.sliceId, take]]);

  const priced = priceAssignment(
    context.candidates,
    reductions,
    context.settings,
    context.assumedDurationSeconds,
  );

  const depthPercent = (take / Math.max(victim.baselineAllocatedMbps, 1e-9)) * 100;

  return {
    strategy: 'SINGLE_VICTIM',
    description:
      'Take the entire reduction from one slice, minimising the number of departments affected.',
    totalHarm: priced.totalHarm,
    harmPenaltyPercent: penaltyOf(priced.totalHarm, context.chosenHarm, take >= context.requiredReductionMbps - 1e-6),
    feasible: take >= context.requiredReductionMbps - 1e-6,
    achievedReductionMbps: priced.achievedReductionMbps,
    affectedSliceCount: 1,
    rejectedBecause:
      `Requires cutting ${victim.sliceName} by ${round(depthPercent, 1)}% in a single step. ` +
      `With a harm curvature of ${victim.harmCurvature} for its recovery tolerance, the final ` +
      `percentages of that cut cost far more than the first percentages taken from several slices.`,
  };
}

/**
 * STRATEGY: PROTECT STRESSED — exclude any slice already near an SLA breach.
 *
 * The instinct of an operator watching the dashboard turn red. Frequently INFEASIBLE
 * during a serious incident, because the slices near breach are exactly the ones holding
 * the bandwidth — and demonstrating that infeasibility is the point of pricing it.
 */
function protectStressedStrategy(context: AlternativeContext): AlternativePlan | null {
  const STRESS_THRESHOLD = 0.7;

  const eligible = context.candidates.filter(
    (c) => headroomOf(c) > 0 && c.slaStress < STRESS_THRESHOLD,
  );
  const excluded = context.candidates.filter(
    (c) => headroomOf(c) > 0 && c.slaStress >= STRESS_THRESHOLD,
  );

  if (eligible.length === 0 && excluded.length === 0) return null;

  const reductions = new Map<string, number>();
  let remaining = context.requiredReductionMbps;

  for (const candidate of [...eligible].sort((a, b) => a.priority.score - b.priority.score)) {
    if (remaining <= 1e-9) break;
    const take = Math.min(headroomOf(candidate), remaining);
    if (take <= 1e-9) continue;
    reductions.set(candidate.sliceId, take);
    remaining -= take;
  }

  const priced = priceAssignment(
    context.candidates,
    reductions,
    context.settings,
    context.assumedDurationSeconds,
  );

  const feasible = remaining <= 1e-6;

  return {
    strategy: 'PROTECT_STRESSED',
    description:
      `Exclude every slice already consuming more than ${STRESS_THRESHOLD * 100}% of its SLA budget, ` +
      'then degrade the remainder by ascending priority.',
    totalHarm: priced.totalHarm,
    harmPenaltyPercent: penaltyOf(priced.totalHarm, context.chosenHarm, feasible),
    feasible,
    achievedReductionMbps: priced.achievedReductionMbps,
    affectedSliceCount: reductions.size,
    rejectedBecause: feasible
      ? `Achievable, but it ignores business priority among the remaining slices and leaves ` +
        `${excluded.length} slice(s) untouched purely because they are already stressed — which is a ` +
        `network-health argument, not a business one.`
      : `Infeasible: excluding ${excluded.length} stressed slice(s) leaves only ` +
        `${round(context.requiredReductionMbps - remaining, 1)} kbps of the ` +
        `${round(context.requiredReductionMbps, 1)} kbps required. The stressed slices are holding the ` +
        `bandwidth, so protecting all of them cannot resolve the contention.`,
  };
}

/* ------------------------------------------------------------------ */

/**
 * How much worse an alternative is than the chosen plan, as a percentage.
 *
 * Returns NULL for an infeasible alternative. Harm is only comparable between plans that
 * free comparable bandwidth: an infeasible strategy inevitably shows LOWER total harm
 * because it degrades less, while failing to resolve the contention at all. Reporting that
 * as a negative penalty would rank a plan that does not work above the one that does.
 */
function penaltyOf(alternativeHarm: number, chosenHarm: number, feasible: boolean): number | null {
  if (!feasible) return null;
  if (chosenHarm <= 0) return alternativeHarm > 0 ? 100 : 0;
  return round(safeDivide(alternativeHarm - chosenHarm, chosenHarm, 0) * 100, 2);
}
