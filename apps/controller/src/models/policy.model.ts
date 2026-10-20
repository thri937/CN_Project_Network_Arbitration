import { z } from 'zod';
import {
  COMPLIANCE_LEVELS,
  CUSTOMER_IMPACTS,
  ComplianceLevel,
  CustomerImpact,
  DEPARTMENT_CRITICALITIES,
  DepartmentCriticality,
  RECOVERY_TOLERANCES,
  RecoveryTolerance,
} from '@/constants/enums';
import {
  ArbitrationTunables,
  COMPLIANCE_DEGRADATION_CEILING_PCT,
  COMPLIANCE_SCORE,
  CRITICALITY_SCORE,
  CUSTOMER_IMPACT_SCORE,
  DEFAULT_POLICY_WEIGHTS,
  DOWNTIME_COST_REFERENCE_PER_MINUTE,
  RECOVERY_TOLERANCE_PROFILE,
  type PolicyWeightVector,
} from '@/constants/tunables';
import {
  auditableShape,
  descriptionSchema,
  displayNameSchema,
  isoDateTime,
  scoreSchema,
} from './base.model';

/**
 * Business policy — the governance layer above departments.
 *
 * A Department says how important a business unit is. A Policy says how those statements
 * are weighed against one another, and how ordinal judgements ("MISSION_CRITICAL") become
 * the cardinal numbers the arbitration mathematics requires.
 *
 * IMMUTABILITY AND VERSIONING
 * ===========================
 * An ACTIVE policy is never edited in place. Editing produces a NEW revision; the previous
 * one is archived and retained forever. Combined with each arbitration decision recording
 * `policyId` + `policyVersion` + the resolved weights, this guarantees that a decision made
 * in March is still fully explainable in December — even though the policy has since
 * changed three times. Mutating an active policy would silently rewrite the justification
 * for every past decision, which is the difference between an audit trail and a story.
 *
 * Exactly one policy is ACTIVE at any moment; `PolicyService.activate` enforces this
 * transactionally.
 */

export const PolicyStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;
export type PolicyStatus = (typeof PolicyStatus)[keyof typeof PolicyStatus];

/* ------------------------------------------------------------------ */
/* Weight vector                                                       */
/* ------------------------------------------------------------------ */

const weightSchema = z.number().min(0).max(1);

export const PolicyWeightsSchema = z
  .object({
    departmentCriticality: weightSchema,
    businessImportance: weightSchema,
    downtimeCost: weightSchema,
    compliance: weightSchema,
    customerImpact: weightSchema,
    operationalImportance: weightSchema,
    recoveryIntolerance: weightSchema,
  })
  .refine(
    (weights) => Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 1e-6,
    {
      // Weights that do not sum to 1 make scores incomparable between policy revisions,
      // which silently breaks every historical trend chart and fairness calculation.
      message: 'Weights must sum to exactly 1.0',
    },
  );

/* ------------------------------------------------------------------ */
/* Ordinal → cardinal override tables                                  */
/* ------------------------------------------------------------------ */

/**
 * A tenant may retune the translation from ordinal business language to numbers — for
 * example, deciding that in their organisation the gap between BUSINESS_CRITICAL and
 * BUSINESS_OPERATIONAL is wider than the defaults assume. Overrides are partial; anything
 * omitted falls back to `constants/tunables.ts`.
 */
export const ScoreOverridesSchema = z
  .object({
    criticality: z
      .record(
        z.enum(DEPARTMENT_CRITICALITIES as [DepartmentCriticality, ...DepartmentCriticality[]]),
        scoreSchema,
      )
      .optional(),
    compliance: z
      .record(z.enum(COMPLIANCE_LEVELS as [ComplianceLevel, ...ComplianceLevel[]]), scoreSchema)
      .optional(),
    customerImpact: z
      .record(z.enum(CUSTOMER_IMPACTS as [CustomerImpact, ...CustomerImpact[]]), scoreSchema)
      .optional(),
    recoveryIntolerance: z
      .record(z.enum(RECOVERY_TOLERANCES as [RecoveryTolerance, ...RecoveryTolerance[]]), scoreSchema)
      .optional(),
  })
  .strict();

/**
 * Compliance ceilings may be TIGHTENED by a policy but never loosened beyond the built-in
 * defaults — a tenant must not be able to configure their way out of a life-safety
 * exemption. The rule is enforced in `assertCeilingsOnlyTighten`.
 */
export const ComplianceCeilingOverridesSchema = z
  .record(z.enum(COMPLIANCE_LEVELS as [ComplianceLevel, ...ComplianceLevel[]]), z.number().min(0).max(100))
  .optional();

/* ------------------------------------------------------------------ */
/* Arbitration tuning                                                  */
/* ------------------------------------------------------------------ */

export const ArbitrationSettingsSchema = z
  .object({
    /** λ — strength of the historical-fairness correction. 0 disables burden rotation. */
    fairnessLambda: z.number().min(0).max(3).default(ArbitrationTunables.FAIRNESS_LAMBDA),
    /** How far back degradation burden is accumulated, in seconds. */
    fairnessLookbackSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 24 * 3600)
      .default(ArbitrationTunables.FAIRNESS_LOOKBACK_SECONDS),
    /** Amplification applied to slices already near their SLA floor. */
    slaStressGain: z.number().min(0).max(3).default(ArbitrationTunables.SLA_STRESS_GAIN),
    /** Utilisation headroom the allocator targets, as a fraction. */
    targetHeadroomFraction: z
      .number()
      .min(0)
      .max(0.25)
      .default(ArbitrationTunables.TARGET_HEADROOM_FRACTION),
    /** Water-filling step size as a fraction of demand. Smaller = finer, slower. */
    degradationQuantum: z
      .number()
      .min(0.0005)
      .max(0.05)
      .default(ArbitrationTunables.DEGRADATION_QUANTUM),
    /** Reference downtime cost that maps to a score of 50. */
    downtimeCostReference: z
      .number()
      .positive()
      .default(DOWNTIME_COST_REFERENCE_PER_MINUTE),
    /** Require an administrator to approve before a plan is applied. */
    requireApproval: z.boolean().default(false),
  })
  .strict();

export type ArbitrationSettings = z.infer<typeof ArbitrationSettingsSchema>;

/* ------------------------------------------------------------------ */
/* Entity                                                              */
/* ------------------------------------------------------------------ */

export const PolicySchema = z.object({
  ...auditableShape,

  name: displayNameSchema,
  description: descriptionSchema,

  /**
   * Policy revision number, distinct from the entity's optimistic-locking `version`.
   * Increments across the whole lineage: revision 4 supersedes revision 3.
   */
  revision: z.number().int().positive(),
  /** Id of the revision this one was derived from, forming an audit chain. */
  supersedes: z.string().min(1).optional(),

  status: z.nativeEnum(PolicyStatus),
  effectiveFrom: isoDateTime.optional(),
  archivedAt: isoDateTime.optional(),

  weights: PolicyWeightsSchema,
  scoreOverrides: ScoreOverridesSchema.default({}),
  complianceCeilingOverrides: ComplianceCeilingOverridesSchema,
  arbitration: ArbitrationSettingsSchema,

  /** Free-text governance justification, surfaced in the policy history view. */
  rationale: z.string().trim().max(4000).optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

/* ------------------------------------------------------------------ */
/* API payloads                                                        */
/* ------------------------------------------------------------------ */

export const CreatePolicySchema = z
  .object({
    name: displayNameSchema,
    description: descriptionSchema,
    weights: PolicyWeightsSchema.optional(),
    scoreOverrides: ScoreOverridesSchema.optional(),
    complianceCeilingOverrides: ComplianceCeilingOverridesSchema,
    arbitration: ArbitrationSettingsSchema.partial().optional(),
    rationale: z.string().trim().max(4000).optional(),
  })
  .strict();

export const UpdatePolicySchema = CreatePolicySchema.partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be supplied',
  });

export type CreatePolicyPayload = z.infer<typeof CreatePolicySchema>;
export type UpdatePolicyPayload = z.infer<typeof UpdatePolicySchema>;

export const PolicyListQuerySchema = z.object({
  status: z.nativeEnum(PolicyStatus).optional(),
});

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * A policy with every override merged over the built-in defaults.
 *
 * The domain engines consume ONLY this shape. They never see an optional field, never
 * consult `constants/tunables.ts` themselves, and therefore cannot disagree with the
 * policy that was in force. A resolved policy is also what gets snapshotted into an
 * arbitration decision, which is what makes historical decisions replayable.
 */
export interface ResolvedPolicy {
  policyId: string;
  policyName: string;
  revision: number;
  weights: PolicyWeightVector;
  criticalityScore: Record<DepartmentCriticality, number>;
  complianceScore: Record<ComplianceLevel, number>;
  customerImpactScore: Record<CustomerImpact, number>;
  recoveryIntoleranceScore: Record<RecoveryTolerance, number>;
  harmCurvature: Record<RecoveryTolerance, number>;
  recoveryWindowSeconds: Record<RecoveryTolerance, number>;
  complianceCeilingPercent: Record<ComplianceLevel, number>;
  arbitration: ArbitrationSettings;
}

export function resolvePolicy(policy: Policy): ResolvedPolicy {
  const overrides = policy.scoreOverrides ?? {};

  return {
    policyId: policy.id,
    policyName: policy.name,
    revision: policy.revision,
    weights: policy.weights,
    criticalityScore: { ...CRITICALITY_SCORE, ...(overrides.criticality ?? {}) },
    complianceScore: { ...COMPLIANCE_SCORE, ...(overrides.compliance ?? {}) },
    customerImpactScore: { ...CUSTOMER_IMPACT_SCORE, ...(overrides.customerImpact ?? {}) },
    recoveryIntoleranceScore: {
      ...mapProfile((p) => p.intoleranceScore),
      ...(overrides.recoveryIntolerance ?? {}),
    },
    harmCurvature: mapProfile((p) => p.harmCurvature),
    recoveryWindowSeconds: mapProfile((p) => p.recoveryWindowSeconds),
    complianceCeilingPercent: tightenCeilings(policy.complianceCeilingOverrides),
    arbitration: policy.arbitration,
  };
}

function mapProfile(pick: (profile: (typeof RECOVERY_TOLERANCE_PROFILE)[RecoveryTolerance]) => number) {
  return Object.fromEntries(
    Object.entries(RECOVERY_TOLERANCE_PROFILE).map(([key, profile]) => [key, pick(profile)]),
  ) as Record<RecoveryTolerance, number>;
}

/**
 * Merge ceiling overrides, taking the MINIMUM of the override and the built-in default.
 *
 * A policy may make compliance stricter; it may never make it looser. Without this clamp a
 * tenant could set `LIFE_SAFETY: 100` and configure away the one constraint that exists to
 * stop the platform degrading a life-safety slice.
 */
function tightenCeilings(
  overrides: Partial<Record<ComplianceLevel, number>> | undefined,
): Record<ComplianceLevel, number> {
  const result = { ...COMPLIANCE_DEGRADATION_CEILING_PCT };
  if (!overrides) return result;

  for (const [level, value] of Object.entries(overrides) as [ComplianceLevel, number][]) {
    result[level] = Math.min(COMPLIANCE_DEGRADATION_CEILING_PCT[level], value);
  }
  return result;
}

/** The built-in policy used when a deployment has none configured. */
export function defaultPolicyDefinition(): Omit<
  Policy,
  'id' | 'createdAt' | 'updatedAt' | 'version'
> {
  return {
    name: 'Default Business Arbitration Policy',
    description:
      'Built-in baseline weighting. Balances department criticality and measured downtime ' +
      'cost, with compliance modelled as a hard constraint rather than a weight.',
    revision: 1,
    status: PolicyStatus.ACTIVE,
    weights: { ...DEFAULT_POLICY_WEIGHTS },
    scoreOverrides: {},
    arbitration: ArbitrationSettingsSchema.parse({}),
    rationale: 'Seeded automatically so the platform has a governing policy from first boot.',
  };
}
