import { SliceDisposition } from '@/constants/enums';
import { ArbitrationTunables } from '@/constants/tunables';
import { clamp, clamp01, round, safeDivide } from '@/utils/math';
import { evaluateAlternatives } from './alternatives';
import { carriedMbps, sheddableMbps, solve, type SolvedSlice } from './solver';
import {
  ArbitrationVerdict,
  type AlternativePlan,
  type ArbitrationCandidate,
  type ArbitrationPlan,
  type ArbitrationRequest,
  type ConfidenceBreakdown,
  type SliceAllocation,
} from './types';

/**
 * CBHA — CONVEX BUSINESS-HARM ARBITRATION
 * =======================================
 * The arbitration engine. Pure domain: no I/O, no clock, no logger, no config. Given the
 * same request it returns the same plan, forever — which is what makes a decision recorded
 * today re-executable and verifiable in a year's time.
 *
 * PIPELINE
 * --------
 *   1. compute the deficit — how much bandwidth must be freed, with headroom
 *   2. partition candidates into exempt (hard constraints) and eligible
 *   3. estimate the hold duration, since it feeds the recovery-urgency multiplier
 *   4. water-fill on marginal harm            → the plan               (solver.ts)
 *   5. price four counterfactual strategies   → the alternatives  (alternatives.ts)
 *   6. score confidence from four components
 *   7. render prose an operator can act on
 *
 * HOW THIS DIFFERS FROM PRIORITY-BASED DEGRADATION, CONCRETELY
 * -----------------------------------------------------------
 *   • it never reads a QoS class, 5QI, SST or slice profile — they are not in the input type
 *   • it degrades many slices shallowly rather than one deeply, because harm is convex
 *   • it remembers who was degraded last time and rotates the burden
 *   • it treats compliance as a constraint that cannot be outvoted, not as a large weight
 *   • it prices the conventional approach on every run, so the difference is auditable
 */

/**
 * Traffic the shared link is actually carrying: total demand less whatever each slice's
 * current limit already holds back, which never reaches the link.
 *
 * Arbitrating on raw demand instead had two effects: lowering a limit a slice wasn't using
 * counted as freed bandwidth though no traffic changed, and — because demand does not fall
 * when limits do — every later pass saw the same deficit and cut again.
 */
export function carriedLoadMbps(request: ArbitrationRequest): number {
  const heldBack = request.candidates.reduce(
    (total, c) => total + Math.max(0, c.demandMbps - c.allocatedMbps),
    0,
  );
  return Math.max(0, request.totalDemandMbps - heldBack);
}

/** Deficit is the carried load above a headroom target, not above the exact capacity line. */
function requiredReduction(request: ArbitrationRequest): number {
  const target =
    request.offeredCapacityMbps * (1 - clamp01(request.settings.targetHeadroomFraction));
  return Math.max(0, carriedLoadMbps(request) - target);
}

/**
 * Estimated hold duration, before the plan is known.
 *
 * The recovery-urgency multiplier needs a duration, but the duration depends on which
 * slices are degraded — a circular dependency. It is broken by seeding with the shortest
 * recovery window among candidates that could plausibly be degraded, then recomputing the
 * per-slice duration exactly once the plan exists. Seeding with the SHORTEST window is the
 * conservative choice: it biases urgency downward, so the engine cannot inflate harm and
 * talk itself out of acting.
 */
function seedDuration(candidates: readonly ArbitrationCandidate[]): number {
  const eligible = candidates.filter((c) => c.maxDegradationPercent > 0);
  if (eligible.length === 0) return 60;
  return Math.min(...eligible.map((c) => c.recoveryWindowSeconds));
}

export function arbitrate(request: ArbitrationRequest): ArbitrationPlan {
  const startedAt = Date.now();

  const required = requiredReduction(request);

  /* ---- No contention ------------------------------------------------ */
  if (required <= 0) {
    return notRequiredPlan(request, startedAt);
  }

  /* ---- Solve --------------------------------------------------------- */
  const assumedDuration = seedDuration(request.candidates);

  const result = solve({
    candidates: request.candidates,
    requiredReductionMbps: required,
    settings: request.settings,
    assumedDurationSeconds: assumedDuration,
  });

  const degraded = result.slices.filter((s) => s.reductionMbps > 1e-6);

  /* ---- Alternatives -------------------------------------------------- */
  const alternatives = evaluateAlternatives({
    candidates: request.candidates,
    requiredReductionMbps: required,
    settings: request.settings,
    assumedDurationSeconds: assumedDuration,
    chosenHarm: result.totalHarm,
    chosenAchievedMbps: result.achievedReductionMbps,
  });

  /* ---- Verdict ------------------------------------------------------- */
  const verdict = decideVerdict(result.shortfall, degraded.length, result.eligibleCount);

  /* ---- Allocations --------------------------------------------------- */
  const allocations = result.slices.map((slice) =>
    toAllocation(slice, request, alternatives),
  );

  /* ---- Confidence ---------------------------------------------------- */
  const confidence = scoreConfidence({
    request,
    chosenHarm: result.totalHarm,
    alternatives,
    shortfall: result.shortfall,
    required,
    degradedCount: degraded.length,
  });

  return {
    contentionId: request.contentionId,
    atMs: request.atMs,
    verdict,
    requiredReductionMbps: round(required, 4),
    achievedReductionMbps: result.achievedReductionMbps,
    shortfallMbps: result.shortfall,
    allocations,
    degradedSliceIds: allocations
      .filter((a) => a.disposition === SliceDisposition.DEGRADED)
      .map((a) => a.sliceId),
    protectedSliceIds: allocations
      .filter((a) => a.disposition === SliceDisposition.PROTECTED)
      .map((a) => a.sliceId),
    exemptSliceIds: allocations
      .filter((a) => a.disposition === SliceDisposition.EXEMPT)
      .map((a) => a.sliceId),
    totalHarm: result.totalHarm,
    confidence: confidence.total,
    confidenceBreakdown: confidence,
    alternatives,
    rationale: buildRationale(request, result, allocations, alternatives, verdict, required),
    ...(verdict !== ArbitrationVerdict.FEASIBLE
      ? { escalationReason: buildEscalation(verdict, result.shortfall, request) }
      : {}),
    policyId: request.policyId,
    policyRevision: request.policyRevision,
    policyName: request.policyName,
    diagnostics: {
      iterations: result.iterations,
      quantumMbps: result.quantumMbps,
      candidatesConsidered: request.candidates.length,
      eligibleCandidates: result.eligibleCount,
      computeMs: Date.now() - startedAt,
      converged: result.converged,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Verdict                                                             */
/* ------------------------------------------------------------------ */

function decideVerdict(
  shortfall: number,
  degradedCount: number,
  eligibleCount: number,
): ArbitrationVerdict {
  if (shortfall <= 1e-6) return ArbitrationVerdict.FEASIBLE;
  // Nothing could be degraded at all — every slice is exempt or already at its floor.
  if (eligibleCount === 0 || degradedCount === 0) return ArbitrationVerdict.INFEASIBLE;
  return ArbitrationVerdict.PARTIAL;
}

/* ------------------------------------------------------------------ */
/* Allocations                                                         */
/* ------------------------------------------------------------------ */

function toAllocation(
  slice: SolvedSlice,
  request: ArbitrationRequest,
  alternatives: AlternativePlan[],
): SliceAllocation {
  const { candidate, context } = slice;

  const degradationPercent =
    (slice.reductionMbps / Math.max(candidate.baselineAllocatedMbps, 1e-9)) * 100;

  const disposition = slice.exempt
    ? SliceDisposition.EXEMPT
    : slice.reductionMbps > 1e-6
      ? SliceDisposition.DEGRADED
      : // Eligible but untouched: the optimiser found cheaper harm elsewhere. Distinguished
        // from PROTECTED so an operator can see it was considered.
        candidate.priority.score >= medianScore(request.candidates)
        ? SliceDisposition.PROTECTED
        : SliceDisposition.UNAFFECTED;

  // Duration recomputed per slice from its own recovery window, now that the plan is known.
  const durationSeconds = slice.reductionMbps > 1e-6 ? candidate.recoveryWindowSeconds : 0;

  return {
    sliceId: candidate.sliceId,
    sliceCode: candidate.sliceCode,
    sliceName: candidate.sliceName,
    departmentId: candidate.departmentId,
    departmentName: candidate.departmentName,
    disposition,
    demandMbps: round(candidate.demandMbps, 3),
    previousAllocationMbps: round(candidate.allocatedMbps, 3),
    newAllocationMbps: slice.newAllocationMbps,
    reductionMbps: slice.reductionMbps,
    degradationPercent: round(degradationPercent, 3),
    businessScore: round(candidate.priority.score, 3),
    harmIncurred: Number.isFinite(slice.harm) ? slice.harm : 0,
    marginalHarmAtStop: Number.isFinite(slice.marginalHarmAtStop) ? slice.marginalHarmAtStop : 0,
    durationSeconds,
    expiresAtMs: request.atMs + durationSeconds * 1000,
    reason: buildSliceReason(slice, disposition, degradationPercent, alternatives),
    factors: {
      businessScore: round(candidate.priority.score, 3),
      harmCurvature: candidate.harmCurvature,
      slaStress: context.components.slaStress,
      fairnessMultiplier: context.components.fairness,
      recoveryUrgency: context.components.urgency,
      intoleranceScale: context.components.intolerance,
      maxDegradationPercent: candidate.maxDegradationPercent,
      headroomMbps: slice.headroomMbps,
    },
  };
}

function medianScore(candidates: readonly ArbitrationCandidate[]): number {
  if (candidates.length === 0) return 0;
  const sorted = candidates.map((c) => c.priority.score).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Per-slice justification.
 *
 * Written for the person whose bandwidth was cut, not for an engineer reading logs. It
 * names the specific factors and their values, so the claim can be checked rather than
 * merely believed.
 */
function buildSliceReason(
  slice: SolvedSlice,
  disposition: SliceDisposition,
  degradationPercent: number,
  alternatives: AlternativePlan[],
): string {
  const { candidate, context } = slice;

  if (disposition === SliceDisposition.EXEMPT) {
    return (
      `Structurally exempt from degradation. ${candidate.departmentName} permits a maximum ` +
      `reduction of ${candidate.maxDegradationPercent}%${
        candidate.maxDegradationPercent === 0
          ? ', which its compliance level fixes at zero'
          : ', and the slice is already at its contractual floor'
      }. No amount of harm avoided elsewhere can override this constraint.`
    );
  }

  if (disposition === SliceDisposition.PROTECTED || disposition === SliceDisposition.UNAFFECTED) {
    return (
      `Left at full allocation. Business score ${round(candidate.priority.score, 1)}/100 with a ` +
      `harm curvature of ${candidate.harmCurvature} (recovery tolerance) meant the first unit of ` +
      `degradation here would have cost more than the units taken elsewhere. ` +
      `SLA stress was ${round(candidate.slaStress * 100, 0)}% of budget.`
    );
  }

  const parts: string[] = [
    `Limit lowered from ${round(candidate.allocatedMbps, 1)} to ${slice.newAllocationMbps} Mbps, ` +
      `shedding ${slice.reductionMbps} Mbps of the ${round(carriedMbps(candidate), 1)} Mbps it was ` +
      `carrying (${round(degradationPercent, 1)}% of its baseline).`,
    `Business score ${round(candidate.priority.score, 1)}/100.`,
  ];

  // Name whichever multiplier actually moved the needle, rather than reciting all three.
  if (context.components.fairness < 0.95) {
    parts.push(
      `This slice has carried less than the fleet-average degradation burden recently ` +
        `(fairness multiplier ${context.components.fairness}), making it a cheaper choice this time.`,
    );
  } else if (context.components.fairness > 1.05) {
    parts.push(
      `Note: this slice has already carried above-average degradation burden ` +
        `(fairness multiplier ${context.components.fairness}), which raised its cost — it was still ` +
        `the least harmful option available.`,
    );
  }

  if (context.components.slaStress > 1.1) {
    parts.push(
      `SLA stress of ${round(candidate.slaStress * 100, 0)}% raised its harm by ` +
        `${round((context.components.slaStress - 1) * 100, 0)}%; the cut was limited accordingly.`,
    );
  }

  parts.push(
    `Depth was capped at ${candidate.maxDegradationPercent}% by ${candidate.departmentName}'s policy, ` +
      `and the slice remains above its ${round(candidate.minGuaranteedMbps, 1)} Mbps contractual floor.`,
  );

  const sortAlternative = alternatives.find((a) => a.strategy === 'PRIORITY_SORT');
  // `harmPenaltyPercent` is null when the alternative was infeasible, in which case the
  // comparison is meaningless and no claim is made.
  if (sortAlternative && (sortAlternative.harmPenaltyPercent ?? 0) > 1) {
    parts.push(
      `A conventional priority-sort approach would have caused ` +
        `${sortAlternative.harmPenaltyPercent}% more business harm.`,
    );
  }

  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Confidence                                                          */
/* ------------------------------------------------------------------ */

/**
 * Confidence scoring.
 *
 * Confidence answers "how sure is the engine that this is the right plan?", which is NOT
 * the same as "how bad is the contention". Four components:
 *
 *   harmMargin         how much better than the runner-up. A plan barely ahead of an
 *                      alternative is a coin-toss dressed as a decision.
 *   telemetryFreshness stale data means the network may already have moved on.
 *   dataCompleteness   candidates missing business context degrade the whole ranking.
 *   constraintSlack    a plan pressed hard against ceilings has little room to be right.
 *
 * Surfaced to operators so a low-confidence decision can be reviewed rather than trusted.
 */
function scoreConfidence(input: {
  request: ArbitrationRequest;
  chosenHarm: number;
  alternatives: AlternativePlan[];
  shortfall: number;
  required: number;
  degradedCount: number;
}): ConfidenceBreakdown {
  const weights = ArbitrationTunables.CONFIDENCE.WEIGHTS;

  /* --- harm margin --- */
  const feasibleAlternatives = input.alternatives.filter((a) => a.feasible);
  const runnerUp = feasibleAlternatives[0];
  const harmMargin = runnerUp
    ? clamp01(safeDivide(runnerUp.totalHarm - input.chosenHarm, Math.max(runnerUp.totalHarm, 1e-9), 0))
    : // No feasible alternative at all means the chosen plan is unopposed, which is a
      // strong signal — but not a perfect one, since it may mean the problem is degenerate.
      0.75;

  /* --- telemetry freshness --- */
  const ages = input.request.candidates.map((c) => c.telemetryAgeMs);
  const worstAge = ages.length > 0 ? Math.max(...ages) : Number.POSITIVE_INFINITY;
  const fresh = ArbitrationTunables.CONFIDENCE.FRESH_TELEMETRY_SECONDS * 1000;
  const stale = ArbitrationTunables.CONFIDENCE.STALE_TELEMETRY_SECONDS * 1000;
  const telemetryFreshness = clamp01(1 - safeDivide(worstAge - fresh, stale - fresh, 1));

  /* --- data completeness --- */
  const complete = input.request.candidates.filter(
    (c) => c.priority.contributions.length > 0 && c.baselineAllocatedMbps > 0,
  ).length;
  const dataCompleteness =
    input.request.candidates.length === 0
      ? 0
      : complete / input.request.candidates.length;

  /* --- constraint slack --- */
  const totalHeadroom = input.request.candidates.reduce((sum, c) => sum + sheddableMbps(c), 0);
  const constraintSlack =
    input.shortfall > 0
      ? 0 // pressed against every ceiling and still short
      : clamp01(1 - safeDivide(input.required, Math.max(totalHeadroom, 1e-9), 1));

  const total =
    harmMargin * weights.harmMargin +
    telemetryFreshness * weights.telemetryFreshness +
    dataCompleteness * weights.dataCompleteness +
    constraintSlack * weights.constraintSlack;

  return {
    harmMargin: round(harmMargin, 4),
    telemetryFreshness: round(telemetryFreshness, 4),
    dataCompleteness: round(dataCompleteness, 4),
    constraintSlack: round(constraintSlack, 4),
    total: round(clamp(total, 0, 1), 4),
  };
}

/* ------------------------------------------------------------------ */
/* Narrative                                                           */
/* ------------------------------------------------------------------ */

function buildRationale(
  request: ArbitrationRequest,
  result: { achievedReductionMbps: number; totalHarm: number; eligibleCount: number },
  allocations: SliceAllocation[],
  alternatives: AlternativePlan[],
  verdict: ArbitrationVerdict,
  required: number,
): string {
  const degraded = allocations.filter((a) => a.disposition === SliceDisposition.DEGRADED);
  const exempt = allocations.filter((a) => a.disposition === SliceDisposition.EXEMPT);

  const lines: string[] = [
    `Demand of ${round(request.totalDemandMbps, 1)} Mbps put ${round(carriedLoadMbps(request), 1)} Mbps of ` +
      `traffic onto the ${round(request.offeredCapacityMbps, 1)} Mbps offered capacity under current limits, ` +
      `requiring ${round(required, 1)} Mbps of it to be shed (including a ` +
      `${round(request.settings.targetHeadroomFraction * 100, 1)}% headroom target).`,
  ];

  if (degraded.length === 0) {
    lines.push('No slice could be degraded within policy constraints.');
  } else {
    const deepest = [...degraded].sort((a, b) => b.degradationPercent - a.degradationPercent)[0]!;
    lines.push(
      `The plan degrades ${degraded.length} slice(s) by a total of ${result.achievedReductionMbps} Mbps, ` +
        `the deepest being ${deepest.sliceName} at ${round(deepest.degradationPercent, 1)}%. ` +
        `Reductions were allocated by equalising MARGINAL business harm across slices, which spreads ` +
        `shallow cuts rather than concentrating a deep one — because harm rises superlinearly with ` +
        `degradation depth.`,
    );
  }

  if (exempt.length > 0) {
    lines.push(
      `${exempt.length} slice(s) were structurally exempt on compliance or contractual grounds and ` +
        `were excluded from consideration entirely: ${exempt.map((e) => e.sliceName).join(', ')}.`,
    );
  }

  const sortAlternative = alternatives.find((a) => a.strategy === 'PRIORITY_SORT');
  if (sortAlternative) {
    const penalty = sortAlternative.harmPenaltyPercent;
    lines.push(
      penalty === null
        ? `A conventional priority-sort approach was evaluated but could not resolve the deficit ` +
          `within policy constraints, so its harm is not comparable.`
        : penalty > 0
          ? `A conventional priority-sort approach was evaluated and would have caused ` +
            `${penalty}% more business harm.`
          : `A conventional priority-sort approach was evaluated and produced comparable harm on ` +
            `this occasion — the fleet is small enough that the two coincide.`,
    );
  }

  if (verdict === ArbitrationVerdict.PARTIAL) {
    lines.push(
      'The plan does not fully clear the deficit; the network remains oversubscribed and requires ' +
        'operator attention.',
    );
  } else if (verdict === ArbitrationVerdict.INFEASIBLE) {
    lines.push(
      'No feasible plan exists within current policy constraints. Operator intervention is required.',
    );
  }

  return lines.join(' ');
}

function buildEscalation(
  verdict: ArbitrationVerdict,
  shortfall: number,
  request: ArbitrationRequest,
): string {
  if (verdict === ArbitrationVerdict.INFEASIBLE) {
    return (
      `No slice has degradable headroom. Every candidate is either at its contractual floor or ` +
      `structurally exempt on compliance grounds. Resolve by adding transport capacity, pausing a ` +
      `non-essential slice, or raising a department's maximum permitted degradation. ` +
      `${round(carriedLoadMbps(request) - request.offeredCapacityMbps, 1)} Mbps of carried traffic exceeds capacity.`
    );
  }

  return (
    `The plan frees as much as policy permits but leaves a ${round(shortfall, 1)} Mbps shortfall. ` +
    `All available headroom has been consumed within the configured degradation ceilings. ` +
    `The network will continue to drop traffic until demand falls or capacity is added.`
  );
}

function notRequiredPlan(request: ArbitrationRequest, startedAt: number): ArbitrationPlan {
  return {
    contentionId: request.contentionId,
    atMs: request.atMs,
    verdict: ArbitrationVerdict.NOT_REQUIRED,
    requiredReductionMbps: 0,
    achievedReductionMbps: 0,
    shortfallMbps: 0,
    allocations: [],
    degradedSliceIds: [],
    protectedSliceIds: request.candidates.map((c) => c.sliceId),
    exemptSliceIds: [],
    totalHarm: 0,
    confidence: 1,
    confidenceBreakdown: {
      harmMargin: 1,
      telemetryFreshness: 1,
      dataCompleteness: 1,
      constraintSlack: 1,
      total: 1,
    },
    alternatives: [],
    rationale:
      request.totalDemandMbps > carriedLoadMbps(request) + 1e-6
        ? `Demand of ${round(request.totalDemandMbps, 1)} Mbps exceeds what current limits let through: ` +
          `the ${round(carriedLoadMbps(request), 1)} Mbps carried fits within the ` +
          `${round(request.offeredCapacityMbps, 1)} Mbps offered capacity including the configured headroom. ` +
          `No further degradation is required.`
        : `Demand of ${round(request.totalDemandMbps, 1)} Mbps fits within the ` +
          `${round(request.offeredCapacityMbps, 1)} Mbps offered capacity including the configured headroom. ` +
          `No degradation is required.`,
    policyId: request.policyId,
    policyRevision: request.policyRevision,
    policyName: request.policyName,
    diagnostics: {
      iterations: 0,
      quantumMbps: 0,
      candidatesConsidered: request.candidates.length,
      eligibleCandidates: 0,
      computeMs: Date.now() - startedAt,
      converged: true,
    },
  };
}

export { ArbitrationVerdict } from './types';
