/**
 * Domain enumerations.
 *
 * These are declared as frozen const objects rather than TypeScript `enum`s because:
 *  - they serialise cleanly to/from Firestore and JSON without reverse-mapping surprises,
 *  - the union types derived from them are structurally comparable across the wire,
 *  - Zod can validate against the same literal tuple used at runtime.
 *
 * IMPORTANT DESIGN NOTE
 * ---------------------
 * `SliceProfile` (eMBB / URLLC / mMTC) and `QosClass` are recorded for interoperability
 * with 3GPP-conformant cores (Open5GS, free5GC) and for reporting. They are deliberately
 * NOT inputs to the arbitration algorithm. Arbitration is driven exclusively by the
 * business-policy attributes defined on `Department` and `Slice`. This separation is the
 * entire thesis of the platform and is enforced by unit tests in
 * `tests/unit/arbitration.invariants.test.ts`.
 */

export const UserRole = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  VIEWER: 'VIEWER',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const USER_ROLES = Object.values(UserRole);

/** Ordered least→most privileged. Used by the RBAC middleware for `atLeast` checks. */
export const ROLE_RANK: Readonly<Record<UserRole, number>> = Object.freeze({
  [UserRole.VIEWER]: 0,
  [UserRole.MANAGER]: 1,
  [UserRole.ADMIN]: 2,
});

/* ------------------------------------------------------------------ */
/* Department business attributes                                      */
/* ------------------------------------------------------------------ */

export const DepartmentCriticality = {
  MISSION_CRITICAL: 'MISSION_CRITICAL',
  BUSINESS_CRITICAL: 'BUSINESS_CRITICAL',
  BUSINESS_OPERATIONAL: 'BUSINESS_OPERATIONAL',
  ADMINISTRATIVE: 'ADMINISTRATIVE',
  BEST_EFFORT: 'BEST_EFFORT',
} as const;
export type DepartmentCriticality =
  (typeof DepartmentCriticality)[keyof typeof DepartmentCriticality];
export const DEPARTMENT_CRITICALITIES = Object.values(DepartmentCriticality);

/**
 * How long a department can tolerate degraded service before business damage compounds.
 * Drives the *curvature* of the harm function, not just its magnitude — a ZERO-tolerance
 * department's harm rises steeply with each additional percent of degradation, which makes
 * the optimiser prefer many shallow cuts elsewhere over one deep cut here.
 */
export const RecoveryTolerance = {
  ZERO: 'ZERO',
  LOW: 'LOW',
  MODERATE: 'MODERATE',
  HIGH: 'HIGH',
} as const;
export type RecoveryTolerance = (typeof RecoveryTolerance)[keyof typeof RecoveryTolerance];
export const RECOVERY_TOLERANCES = Object.values(RecoveryTolerance);

export const ComplianceLevel = {
  NONE: 'NONE',
  INTERNAL: 'INTERNAL',
  CONTRACTUAL: 'CONTRACTUAL',
  REGULATED: 'REGULATED',
  LIFE_SAFETY: 'LIFE_SAFETY',
} as const;
export type ComplianceLevel = (typeof ComplianceLevel)[keyof typeof ComplianceLevel];
export const COMPLIANCE_LEVELS = Object.values(ComplianceLevel);

export const CustomerImpact = {
  NONE: 'NONE',
  INTERNAL_ONLY: 'INTERNAL_ONLY',
  INDIRECT: 'INDIRECT',
  DIRECT: 'DIRECT',
  SEVERE_EXTERNAL: 'SEVERE_EXTERNAL',
} as const;
export type CustomerImpact = (typeof CustomerImpact)[keyof typeof CustomerImpact];
export const CUSTOMER_IMPACTS = Object.values(CustomerImpact);

/* ------------------------------------------------------------------ */
/* Slice                                                               */
/* ------------------------------------------------------------------ */

export const SliceStatus = {
  PROVISIONING: 'PROVISIONING',
  ACTIVE: 'ACTIVE',
  DEGRADED: 'DEGRADED',
  RECOVERING: 'RECOVERING',
  PAUSED: 'PAUSED',
  TERMINATED: 'TERMINATED',
} as const;
export type SliceStatus = (typeof SliceStatus)[keyof typeof SliceStatus];
export const SLICE_STATUSES = Object.values(SliceStatus);

/** Statuses that consume capacity and therefore participate in arbitration. */
export const ARBITRABLE_SLICE_STATUSES: readonly SliceStatus[] = Object.freeze([
  SliceStatus.ACTIVE,
  SliceStatus.DEGRADED,
  SliceStatus.RECOVERING,
]);

/**
 * 3GPP TS 23.501 Slice/Service Type. Carried for core-network interoperability only.
 * NEVER read by the policy or arbitration engines.
 */
export const SliceServiceType = {
  EMBB: 1,
  URLLC: 2,
  MIOT: 3,
  V2X: 4,
} as const;
export type SliceServiceType = (typeof SliceServiceType)[keyof typeof SliceServiceType];

export const SliceProfile = {
  EMBB: 'EMBB',
  URLLC: 'URLLC',
  MMTC: 'MMTC',
  V2X: 'V2X',
} as const;
export type SliceProfile = (typeof SliceProfile)[keyof typeof SliceProfile];
export const SLICE_PROFILES = Object.values(SliceProfile);

/* ------------------------------------------------------------------ */
/* Telemetry & health                                                  */
/* ------------------------------------------------------------------ */

export const HealthState = {
  HEALTHY: 'HEALTHY',
  WARNING: 'WARNING',
  DEGRADED: 'DEGRADED',
  CRITICAL: 'CRITICAL',
  UNKNOWN: 'UNKNOWN',
} as const;
export type HealthState = (typeof HealthState)[keyof typeof HealthState];
export const HEALTH_STATES = Object.values(HealthState);

/* ------------------------------------------------------------------ */
/* Contention & arbitration                                            */
/* ------------------------------------------------------------------ */

export const ContentionSeverity = {
  MINOR: 'MINOR',
  MODERATE: 'MODERATE',
  SEVERE: 'SEVERE',
  CRITICAL: 'CRITICAL',
} as const;
export type ContentionSeverity = (typeof ContentionSeverity)[keyof typeof ContentionSeverity];
export const CONTENTION_SEVERITIES = Object.values(ContentionSeverity);

export const ContentionStatus = {
  DETECTED: 'DETECTED',
  ARBITRATING: 'ARBITRATING',
  MITIGATED: 'MITIGATED',
  UNRESOLVABLE: 'UNRESOLVABLE',
  RESOLVED: 'RESOLVED',
  EXPIRED: 'EXPIRED',
} as const;
export type ContentionStatus = (typeof ContentionStatus)[keyof typeof ContentionStatus];
export const CONTENTION_STATUSES = Object.values(ContentionStatus);

export const ArbitrationOutcome = {
  /** A feasible allocation was found and applied. */
  RESOLVED: 'RESOLVED',
  /** Best-effort applied but demand still exceeds capacity — needs human action. */
  PARTIAL: 'PARTIAL',
  /** No degradation was permitted by policy; escalated without changes. */
  ESCALATED: 'ESCALATED',
  /** Contention disappeared before the plan could be applied. */
  ABORTED: 'ABORTED',
} as const;
export type ArbitrationOutcome = (typeof ArbitrationOutcome)[keyof typeof ArbitrationOutcome];

export const ArbitrationTrigger = {
  AUTOMATIC: 'AUTOMATIC',
  MANUAL: 'MANUAL',
  SIMULATION: 'SIMULATION',
  REPLAY: 'REPLAY',
} as const;
export type ArbitrationTrigger = (typeof ArbitrationTrigger)[keyof typeof ArbitrationTrigger];

/** Per-slice role in a given arbitration decision. */
export const SliceDisposition = {
  /** Kept at full requested allocation. */
  PROTECTED: 'PROTECTED',
  /** Bandwidth reduced. */
  DEGRADED: 'DEGRADED',
  /** Eligible for degradation but the optimiser found cheaper harm elsewhere. */
  UNAFFECTED: 'UNAFFECTED',
  /** Structurally exempt (compliance floor / zero max-degradation). */
  EXEMPT: 'EXEMPT',
} as const;
export type SliceDisposition = (typeof SliceDisposition)[keyof typeof SliceDisposition];

export const RecoveryStatus = {
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  RECOVERED: 'RECOVERED',
  EXTENDED: 'EXTENDED',
  FAILED: 'FAILED',
} as const;
export type RecoveryStatus = (typeof RecoveryStatus)[keyof typeof RecoveryStatus];

/* ------------------------------------------------------------------ */
/* Audit & notifications                                               */
/* ------------------------------------------------------------------ */

export const AuditAction = {
  USER_LOGIN: 'USER_LOGIN',
  USER_ROLE_CHANGED: 'USER_ROLE_CHANGED',
  USER_DISABLED: 'USER_DISABLED',
  DEPARTMENT_CREATED: 'DEPARTMENT_CREATED',
  DEPARTMENT_UPDATED: 'DEPARTMENT_UPDATED',
  DEPARTMENT_DELETED: 'DEPARTMENT_DELETED',
  POLICY_CREATED: 'POLICY_CREATED',
  POLICY_UPDATED: 'POLICY_UPDATED',
  POLICY_ACTIVATED: 'POLICY_ACTIVATED',
  SLICE_CREATED: 'SLICE_CREATED',
  SLICE_UPDATED: 'SLICE_UPDATED',
  SLICE_DELETED: 'SLICE_DELETED',
  SLICE_PAUSED: 'SLICE_PAUSED',
  SLICE_RESUMED: 'SLICE_RESUMED',
  CONTENTION_DETECTED: 'CONTENTION_DETECTED',
  ARBITRATION_EXECUTED: 'ARBITRATION_EXECUTED',
  ARBITRATION_OVERRIDDEN: 'ARBITRATION_OVERRIDDEN',
  ALLOCATION_APPLIED: 'ALLOCATION_APPLIED',
  ALLOCATION_ROLLED_BACK: 'ALLOCATION_ROLLED_BACK',
  RECOVERY_COMPLETED: 'RECOVERY_COMPLETED',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const NotificationSeverity = {
  INFO: 'INFO',
  SUCCESS: 'SUCCESS',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
} as const;
export type NotificationSeverity =
  (typeof NotificationSeverity)[keyof typeof NotificationSeverity];

export const NotificationChannel = {
  DASHBOARD: 'DASHBOARD',
  EMAIL: 'EMAIL',
  SLACK: 'SLACK',
  TEAMS: 'TEAMS',
  WEBHOOK: 'WEBHOOK',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];
