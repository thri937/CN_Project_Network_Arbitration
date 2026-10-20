import { z } from 'zod';
import { ArbitrationOutcome, ArbitrationTrigger, RecoveryStatus, SliceDisposition } from '@/constants/enums';
import { auditableShape, isoDateTime, mbpsSchema, percentSchema, scoreSchema } from './base.model';

/**
 * Arbitration decision record.
 *
 * THE PERMANENT, SELF-CONTAINED ACCOUNT OF ONE DECISION.
 * =====================================================
 * Everything needed to explain, defend and re-execute the decision is stored HERE, denormalised.
 * Nothing is looked up by reference at read time.
 *
 * That is a deliberate departure from normalisation, for one reason: a decision must remain
 * explainable after the world has moved on. Six months later the department's downtime cost
 * has been revised, the policy is on revision 9, and two of the slices have been deleted. A
 * record built from foreign keys would render as a page of dangling references and subtly
 * wrong numbers — which is worse than no record, because it looks authoritative.
 *
 * So the decision stores: the resolved policy, the business scores WITH their factor
 * breakdowns, the counterfactual plans and their harms, and the confidence components. It is
 * readable in isolation, forever.
 */

/* ------------------------------------------------------------------ */
/* Sub-schemas                                                         */
/* ------------------------------------------------------------------ */

export const DecisionFactorSchema = z.object({
  businessScore: scoreSchema,
  harmCurvature: z.number().positive(),
  slaStress: z.number().nonnegative(),
  fairnessMultiplier: z.number().nonnegative(),
  recoveryUrgency: z.number().nonnegative(),
  intoleranceScale: z.number().nonnegative(),
  maxDegradationPercent: percentSchema,
  headroomMbps: mbpsSchema,
});

export const DecisionAllocationSchema = z.object({
  sliceId: z.string().min(1),
  sliceCode: z.string().min(1),
  sliceName: z.string().min(1),
  departmentId: z.string().min(1),
  departmentName: z.string().min(1),

  disposition: z.nativeEnum(SliceDisposition),

  demandMbps: mbpsSchema,
  previousAllocationMbps: mbpsSchema,
  newAllocationMbps: mbpsSchema,
  reductionMbps: mbpsSchema,
  degradationPercent: percentSchema,

  businessScore: scoreSchema,
  harmIncurred: z.number().nonnegative(),
  marginalHarmAtStop: z.number().nonnegative(),

  durationSeconds: z.number().int().nonnegative(),
  expiresAt: isoDateTime.optional(),
  expiresAtMs: z.number().int().nonnegative().optional(),

  reason: z.string().max(4000),
  factors: DecisionFactorSchema,

  /* ---- Enforcement outcome, written by the allocation manager ---- */
  applied: z.boolean().default(false),
  /** What the network actually enforced; may differ from `newAllocationMbps`. */
  effectiveMbps: mbpsSchema.optional(),
  applicationError: z.string().max(1000).optional(),

  recoveryStatus: z.nativeEnum(RecoveryStatus).default(RecoveryStatus.NOT_APPLICABLE),
  recoveredAt: isoDateTime.optional(),
});

export const DecisionAlternativeSchema = z.object({
  strategy: z.string().max(120),
  description: z.string().max(500),
  totalHarm: z.number().nonnegative(),
  /** Null when the alternative was infeasible — see `AlternativePlan` for why. */
  harmPenaltyPercent: z.number().nullable(),
  feasible: z.boolean(),
  achievedReductionMbps: mbpsSchema,
  affectedSliceCount: z.number().int().nonnegative(),
  rejectedBecause: z.string().max(1000),
});

/**
 * The policy as it stood when the decision was taken.
 *
 * Snapshotted in full, not referenced. This is what makes a March decision explainable in
 * December after the policy has been revised three times.
 */
export const PolicySnapshotSchema = z.object({
  policyId: z.string().min(1),
  policyName: z.string().max(200),
  revision: z.number().int().nonnegative(),
  weights: z.record(z.number()),
  arbitration: z.record(z.union([z.number(), z.boolean()])),
});

/* ------------------------------------------------------------------ */
/* Entity                                                             */
/* ------------------------------------------------------------------ */

export const ArbitrationDecisionSchema = z.object({
  ...auditableShape,

  contentionId: z.string().min(1),
  trigger: z.nativeEnum(ArbitrationTrigger),
  outcome: z.nativeEnum(ArbitrationOutcome),
  /** Engine verdict before application; `outcome` reflects what actually happened. */
  verdict: z.string().max(32),

  decidedAt: isoDateTime,
  decidedAtMs: z.number().int().nonnegative(),

  /* ---- Conditions ---------------------------------------------------- */
  offeredCapacityMbps: mbpsSchema,
  totalDemandMbps: mbpsSchema,
  requiredReductionMbps: mbpsSchema,
  achievedReductionMbps: mbpsSchema,
  shortfallMbps: mbpsSchema,

  /* ---- The plan ------------------------------------------------------ */
  allocations: z.array(DecisionAllocationSchema).max(500),
  degradedSliceIds: z.array(z.string()).max(500),
  protectedSliceIds: z.array(z.string()).max(500),
  exemptSliceIds: z.array(z.string()).max(500),

  totalHarm: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  confidenceBreakdown: z.record(z.number()),

  alternatives: z.array(DecisionAlternativeSchema).max(10),
  rationale: z.string().max(8000),
  escalationReason: z.string().max(2000).optional(),

  policySnapshot: PolicySnapshotSchema,

  /* ---- Attribution ---------------------------------------------------- */
  /** `system` for automatic runs; a user id when manually triggered or overridden. */
  administrator: z.string().max(128),
  administratorEmail: z.string().max(254).optional(),
  overriddenBy: z.string().max(128).optional(),
  overrideReason: z.string().max(2000).optional(),

  /* ---- Lifecycle ------------------------------------------------------- */
  recoveryStatus: z.nativeEnum(RecoveryStatus).default(RecoveryStatus.PENDING),
  fullyRecoveredAt: isoDateTime.optional(),
  /** Earliest expiry across degraded slices; drives the recovery scheduler. */
  nextRecoveryAtMs: z.number().int().nonnegative().optional(),

  diagnostics: z.record(z.union([z.number(), z.boolean()])),
});

export type ArbitrationDecision = z.infer<typeof ArbitrationDecisionSchema>;
export type DecisionAllocation = z.infer<typeof DecisionAllocationSchema>;

/* ------------------------------------------------------------------ */
/* Query & command schemas                                             */
/* ------------------------------------------------------------------ */

export const ArbitrationQuerySchema = z.object({
  contentionId: z.string().min(1).optional(),
  sliceId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  outcome: z.nativeEnum(ArbitrationOutcome).optional(),
  trigger: z.nativeEnum(ArbitrationTrigger).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

/** Manual arbitration trigger. */
export const TriggerArbitrationSchema = z
  .object({
    /** Compute and return a plan WITHOUT applying it. */
    dryRun: z.boolean().default(false),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * Administrator override of an in-force decision.
 *
 * Requires a reason: an override with no recorded justification is precisely the
 * unaccountable intervention this platform exists to eliminate.
 */
export const OverrideDecisionSchema = z
  .object({
    reason: z.string().trim().min(10).max(2000),
    /** Restore every degraded slice immediately. */
    restoreAll: z.boolean().default(true),
  })
  .strict();

export type TriggerArbitrationPayload = z.infer<typeof TriggerArbitrationSchema>;
export type OverrideDecisionPayload = z.infer<typeof OverrideDecisionSchema>;
