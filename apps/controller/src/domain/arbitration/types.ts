import type { SliceDisposition } from '@/constants/enums';
import type { BusinessPriorityScore } from '../policyEngine';

/**
 * Arbitration engine types.
 *
 * Kept separate from the algorithm so the shapes can be imported by the audit model, the
 * REST layer and the frontend without pulling in the solver.
 */

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/**
 * One slice as the arbitration engine sees it.
 *
 * NOTE WHAT IS ABSENT: there is no `profile`, no `sst`, no `qosClass`, no `fiveQi`. The
 * engine cannot consider network-layer priority because it is not in the type. That
 * omission is the platform's thesis expressed as a compile-time guarantee, and
 * `arbitration.invariants.test.ts` asserts it end-to-end.
 */
export interface ArbitrationCandidate {
  sliceId: string;
  sliceCode: string;
  sliceName: string;
  departmentId: string;
  departmentName: string;

  /** What the slice is asking for right now. */
  demandMbps: number;
  /** What it currently holds. */
  allocatedMbps: number;
  /** Contractual entitlement when uncontended; the recovery target. */
  baselineAllocatedMbps: number;
  /** Contractual floor. Never crossed, by any plan. */
  minGuaranteedMbps: number;

  /** From the Business Policy Engine. */
  priority: BusinessPriorityScore;

  /**
   * Effective ceiling on degradation, as a percentage of the baseline: the tighter of the
   * department's own limit and its compliance ceiling. Zero means structurally exempt.
   */
  maxDegradationPercent: number;

  /** Harm curvature γ, from the department's recovery tolerance. */
  harmCurvature: number;
  /**
   * Recovery intolerance, 0–100, from the department's recovery tolerance.
   *
   * Distinct from `harmCurvature` and both are required. Curvature controls how fast harm
   * ACCELERATES with depth; intolerance controls its overall LEVEL. Modelling intolerance
   * through curvature alone is mathematically backwards — see the note in `harm.ts`.
   */
  recoveryIntoleranceScore: number;
  /** Seconds this department can remain degraded before the decision must be revisited. */
  recoveryWindowSeconds: number;
  /** Cost per minute of a full outage, used for recovery urgency. */
  downtimeCostPerMinute: number;

  /** 0–1 live SLA margin consumption. Amplifies harm. */
  slaStress: number;
  /** Σ (degradation fraction × seconds) over the fairness window. */
  burdenScore: number;

  /** Freshness of the telemetry backing this candidate, in ms. Feeds confidence. */
  telemetryAgeMs: number;
}

export interface ArbitrationRequest {
  contentionId: string;
  /** Every arbitrable slice. Arbitration is global; a partial set gives a wrong answer. */
  candidates: ArbitrationCandidate[];
  offeredCapacityMbps: number;
  totalDemandMbps: number;
  /** Epoch ms; injected so a replay reproduces the original decision exactly. */
  atMs: number;
  /** Resolved arbitration settings from the governing policy. */
  settings: ArbitrationSettingsInput;
  policyId: string;
  policyRevision: number;
  policyName: string;
}

export interface ArbitrationSettingsInput {
  fairnessLambda: number;
  fairnessLookbackSeconds: number;
  slaStressGain: number;
  targetHeadroomFraction: number;
  degradationQuantum: number;
  downtimeCostReference: number;
  requireApproval: boolean;
}

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

/** What the plan does to one slice, and why. */
export interface SliceAllocation {
  sliceId: string;
  sliceCode: string;
  sliceName: string;
  departmentId: string;
  departmentName: string;

  disposition: SliceDisposition;

  demandMbps: number;
  previousAllocationMbps: number;
  newAllocationMbps: number;
  reductionMbps: number;
  degradationPercent: number;

  businessScore: number;
  /** Total harm this cut inflicts, in the engine's harm units. */
  harmIncurred: number;
  /** Marginal harm per Mbps at the final allocation — what the NEXT Mbps would have cost. */
  marginalHarmAtStop: number;

  /** Seconds before this slice is restored to baseline. */
  durationSeconds: number;
  expiresAtMs: number;

  /** Why this slice was chosen, in prose an operator can act on. */
  reason: string;
  /** Structured factors behind the choice, for the drill-down view. */
  factors: {
    businessScore: number;
    harmCurvature: number;
    slaStress: number;
    fairnessMultiplier: number;
    recoveryUrgency: number;
    /** Harm level multiplier from recovery intolerance; see `harm.ts`. */
    intoleranceScale: number;
    maxDegradationPercent: number;
    headroomMbps: number;
  };
}

/** A counterfactual plan the engine evaluated and rejected. */
export interface AlternativePlan {
  strategy: string;
  description: string;
  totalHarm: number;
  /**
   * How much worse than the chosen plan, as a percentage — or NULL when the comparison
   * would be meaningless.
   *
   * Harm is only comparable between plans that free comparable bandwidth. An INFEASIBLE
   * alternative always shows lower total harm, for the trivial reason that it degrades
   * less — it simply fails to resolve the contention. Reporting that as a negative penalty
   * would present a plan that does not work as the better option, which is exactly the kind
   * of confidently-wrong number this platform exists to eliminate.
   */
  harmPenaltyPercent: number | null;
  feasible: boolean;
  /** Bandwidth this strategy would free, so the reader can judge comparability. */
  achievedReductionMbps: number;
  affectedSliceCount: number;
  rejectedBecause: string;
}

export interface ConfidenceBreakdown {
  /** Margin between the chosen plan and the next-best, normalised. */
  harmMargin: number;
  /** How fresh the telemetry was. */
  telemetryFreshness: number;
  /** Whether every candidate had complete data. */
  dataCompleteness: number;
  /** How much slack remains against the constraints. */
  constraintSlack: number;
  /** Weighted total, 0–1. */
  total: number;
}

export const ArbitrationVerdict = {
  /** A feasible plan was found that clears the deficit. */
  FEASIBLE: 'FEASIBLE',
  /** The best possible plan does not clear the whole deficit. */
  PARTIAL: 'PARTIAL',
  /** No degradation is permitted at all; nothing can be done automatically. */
  INFEASIBLE: 'INFEASIBLE',
  /** No contention: demand already fits. */
  NOT_REQUIRED: 'NOT_REQUIRED',
} as const;
export type ArbitrationVerdict = (typeof ArbitrationVerdict)[keyof typeof ArbitrationVerdict];

export interface ArbitrationPlan {
  contentionId: string;
  atMs: number;
  verdict: ArbitrationVerdict;

  /** Mbps that had to be freed. */
  requiredReductionMbps: number;
  /** Mbps the plan actually frees. */
  achievedReductionMbps: number;
  /** Shortfall when PARTIAL. */
  shortfallMbps: number;

  allocations: SliceAllocation[];
  /** Convenience projections over `allocations`. */
  degradedSliceIds: string[];
  protectedSliceIds: string[];
  exemptSliceIds: string[];

  totalHarm: number;
  confidence: number;
  confidenceBreakdown: ConfidenceBreakdown;

  alternatives: AlternativePlan[];

  /** Human-readable account of the whole decision. */
  rationale: string;
  /** Set when the verdict is INFEASIBLE or PARTIAL. */
  escalationReason?: string;

  /** Snapshot of the governing policy, so the decision stays explainable forever. */
  policyId: string;
  policyRevision: number;
  policyName: string;

  /** Solver diagnostics, surfaced on the decision drill-down. */
  diagnostics: {
    iterations: number;
    quantumMbps: number;
    candidatesConsidered: number;
    eligibleCandidates: number;
    computeMs: number;
    converged: boolean;
  };
}
