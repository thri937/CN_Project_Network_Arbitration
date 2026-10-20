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
import { COMPLIANCE_DEGRADATION_CEILING_PCT } from '@/constants/tunables';
import {
  auditableShape,
  currencySchema,
  descriptionSchema,
  displayNameSchema,
  emailSchema,
  percentSchema,
  scoreSchema,
  slugSchema,
  tagsSchema,
} from './base.model';

/**
 * Department entity — the business context that drives arbitration.
 *
 * THE CENTRAL IDEA OF THE PLATFORM LIVES IN THIS FILE.
 * ===================================================
 * A conventional slicing controller degrades whichever slice has the lowest QoS priority.
 * That is a network-engineering answer to a business question, and it produces outcomes
 * like "we throttled the cardiology ward's telemetry because it was tagged eMBB while the
 * cafeteria digital-signage slice happened to be URLLC".
 *
 * These fields replace that. Every one is something a business stakeholder can state and
 * defend without knowing what a 5QI is:
 *
 *   criticality               how central is this unit to the enterprise operating at all
 *   businessImportance        relative standing among peers (0–100)
 *   downtimeCostPerMinute     what an outage actually costs, in money
 *   recoveryTolerance         how long it can run degraded before damage compounds
 *   maxAllowedDegradationPct  the contractual floor nobody may cross
 *   complianceLevel           whether degradation carries legal or safety consequences
 *   customerImpact            whether end customers feel it
 *   operationalImportance     day-to-day operational weight
 *
 * A department's slices inherit this context. Arbitration reads it and nothing else about
 * priority — see the invariant test in `tests/unit/arbitration.invariants.test.ts`.
 */
export const DepartmentSchema = z.object({
  ...auditableShape,

  name: displayNameSchema,
  /** Stable machine key, e.g. `manufacturing-plant-3`. Immutable after creation. */
  code: slugSchema,
  description: descriptionSchema,

  /* ---- Business criticality inputs ---------------------------------- */

  criticality: z.enum(DEPARTMENT_CRITICALITIES as [DepartmentCriticality, ...DepartmentCriticality[]]),

  /** Relative standing among peer departments. Not a duplicate of `criticality`: */
  /** two MISSION_CRITICAL units still need an ordering between them. */
  businessImportance: scoreSchema,

  /**
   * Cost of a full outage, per minute, in the tenant's reporting currency.
   *
   * Unbounded by design — a trading desk and a stationery cupboard differ by orders of
   * magnitude. It is normalised logarithmically before scoring (see `logNormalise`) so one
   * extreme value cannot saturate the weight vector and flatten every other input.
   */
  downtimeCostPerMinute: currencySchema,

  recoveryTolerance: z.enum(RECOVERY_TOLERANCES as [RecoveryTolerance, ...RecoveryTolerance[]]),

  /**
   * Hard contractual ceiling on bandwidth reduction, as a percentage of allocation.
   * The arbitration engine treats this as a CONSTRAINT, never as a weight — no amount of
   * harm avoided elsewhere may push a department past its own ceiling.
   */
  maxAllowedDegradationPercent: percentSchema,

  complianceLevel: z.enum(COMPLIANCE_LEVELS as [ComplianceLevel, ...ComplianceLevel[]]),
  customerImpact: z.enum(CUSTOMER_IMPACTS as [CustomerImpact, ...CustomerImpact[]]),
  operationalImportance: scoreSchema,

  /**
   * Optional multiplier applied to this department's final business priority score.
   *
   * An escape hatch for situations the ordinal model cannot express — a temporary
   * regulatory audit, a product launch. Deliberately bounded to [0.5, 2.0]: a wider range
   * would let an operator override the policy entirely through the back door, which is
   * precisely the ungovernable behaviour this platform exists to replace. Every change is
   * audited.
   */
  policyWeightMultiplier: z.number().min(0.5).max(2).default(1),

  /* ---- Ownership & operations --------------------------------------- */

  ownerName: displayNameSchema.optional(),
  ownerEmail: emailSchema.optional(),
  /** Additional addresses notified when this department's slices are degraded. */
  escalationContacts: z.array(emailSchema).max(20).default([]),

  /** Physical or logical site, shown on the topology view. */
  site: z.string().trim().max(120).optional(),

  active: z.boolean().default(true),
  tags: tagsSchema,
});

export type Department = z.infer<typeof DepartmentSchema>;

/* ------------------------------------------------------------------ */
/* API payloads                                                        */
/* ------------------------------------------------------------------ */

const departmentWritableShape = {
  name: displayNameSchema,
  description: descriptionSchema,
  criticality: z.enum(DEPARTMENT_CRITICALITIES as [DepartmentCriticality, ...DepartmentCriticality[]]),
  businessImportance: scoreSchema,
  downtimeCostPerMinute: currencySchema,
  recoveryTolerance: z.enum(RECOVERY_TOLERANCES as [RecoveryTolerance, ...RecoveryTolerance[]]),
  maxAllowedDegradationPercent: percentSchema,
  complianceLevel: z.enum(COMPLIANCE_LEVELS as [ComplianceLevel, ...ComplianceLevel[]]),
  customerImpact: z.enum(CUSTOMER_IMPACTS as [CustomerImpact, ...CustomerImpact[]]),
  operationalImportance: scoreSchema,
  policyWeightMultiplier: z.number().min(0.5).max(2).optional(),
  ownerName: displayNameSchema.optional(),
  ownerEmail: emailSchema.optional(),
  escalationContacts: z.array(emailSchema).max(20).optional(),
  site: z.string().trim().max(120).optional(),
  active: z.boolean().optional(),
  tags: z.array(slugSchema).max(20).optional(),
} as const;

export const CreateDepartmentSchema = z
  .object({
    ...departmentWritableShape,
    /** Immutable once set; omitted values are derived from the name. */
    code: slugSchema.optional(),
  })
  .strict()
  .superRefine(assertComplianceCeilingRespected);

export const UpdateDepartmentSchema = z
  .object(departmentWritableShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be supplied',
  })
  .superRefine(assertComplianceCeilingRespected);

export type CreateDepartmentPayload = z.infer<typeof CreateDepartmentSchema>;
export type UpdateDepartmentPayload = z.infer<typeof UpdateDepartmentSchema>;

/**
 * Cross-field rule: a department cannot declare a degradation ceiling looser than its
 * compliance level permits.
 *
 * Catching this at the API boundary rather than inside the arbitration engine means an
 * operator is told "REGULATED caps degradation at 20 %" while they are editing the form,
 * instead of the engine silently clamping the value at 03:00 during an incident and
 * leaving everyone to wonder why the configured 60 % was ignored.
 */
function assertComplianceCeilingRespected(
  value: { complianceLevel?: ComplianceLevel; maxAllowedDegradationPercent?: number },
  ctx: z.RefinementCtx,
): void {
  if (value.complianceLevel === undefined || value.maxAllowedDegradationPercent === undefined) {
    return; // Partial update; the service re-validates against the merged entity.
  }

  const ceiling = COMPLIANCE_DEGRADATION_CEILING_PCT[value.complianceLevel];
  if (value.maxAllowedDegradationPercent > ceiling) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxAllowedDegradationPercent'],
      message:
        `Compliance level ${value.complianceLevel} caps degradation at ${ceiling}%; ` +
        `${value.maxAllowedDegradationPercent}% was requested`,
    });
  }
}

/** Re-check the rule against a fully merged entity, after a partial update. */
export function validateComplianceCeiling(department: {
  complianceLevel: ComplianceLevel;
  maxAllowedDegradationPercent: number;
}): { ok: true } | { ok: false; ceiling: number } {
  const ceiling = COMPLIANCE_DEGRADATION_CEILING_PCT[department.complianceLevel];
  return department.maxAllowedDegradationPercent > ceiling ? { ok: false, ceiling } : { ok: true };
}

export const DepartmentListQuerySchema = z.object({
  criticality: z
    .enum(DEPARTMENT_CRITICALITIES as [DepartmentCriticality, ...DepartmentCriticality[]])
    .optional(),
  complianceLevel: z.enum(COMPLIANCE_LEVELS as [ComplianceLevel, ...ComplianceLevel[]]).optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  search: z.string().trim().max(120).optional(),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Effective degradation ceiling: the tighter of the department's own limit and the hard
 * ceiling its compliance level imposes. The arbitration engine uses this, never the raw
 * field, so a stale or mis-entered value cannot widen what compliance permits.
 */
export function effectiveDegradationCeiling(department: Department): number {
  return Math.min(
    department.maxAllowedDegradationPercent,
    COMPLIANCE_DEGRADATION_CEILING_PCT[department.complianceLevel],
  );
}

/** True when compliance forbids ANY degradation of this department's slices. */
export function isStructurallyExempt(department: Department): boolean {
  return effectiveDegradationCeiling(department) <= 0;
}

/** Derive a URL-safe code from a display name, e.g. "Plant 3 — OT" → "plant-3-ot". */
export function deriveCode(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
