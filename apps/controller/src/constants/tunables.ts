import {
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
} from './enums';

/**
 * ORDINAL → CARDINAL MAPPINGS
 * ===========================
 * Business stakeholders reason in ordinal terms ("mission critical", "regulated").
 * The arbitration mathematics needs cardinal values. These tables are the single,
 * auditable translation point between the two.
 *
 * They are *defaults*. Every value here can be overridden per-tenant by an active
 * `Policy` document, and the resolved values are snapshotted into each arbitration
 * decision so that a decision made in March can still be explained in December even
 * if the policy has since changed.
 */

/** Department criticality → 0..100 business weight. Non-linear: the gap between */
/** MISSION_CRITICAL and BUSINESS_CRITICAL is intentionally larger than lower steps. */
export const CRITICALITY_SCORE: Readonly<Record<DepartmentCriticality, number>> = Object.freeze({
  [DepartmentCriticality.MISSION_CRITICAL]: 100,
  [DepartmentCriticality.BUSINESS_CRITICAL]: 78,
  [DepartmentCriticality.BUSINESS_OPERATIONAL]: 55,
  [DepartmentCriticality.ADMINISTRATIVE]: 30,
  [DepartmentCriticality.BEST_EFFORT]: 10,
});

export const COMPLIANCE_SCORE: Readonly<Record<ComplianceLevel, number>> = Object.freeze({
  [ComplianceLevel.NONE]: 0,
  [ComplianceLevel.INTERNAL]: 20,
  [ComplianceLevel.CONTRACTUAL]: 50,
  [ComplianceLevel.REGULATED]: 80,
  [ComplianceLevel.LIFE_SAFETY]: 100,
});

/**
 * Compliance is not only a score — it imposes *hard constraints* that the optimiser may
 * never trade away, no matter how much harm is avoided elsewhere. A LIFE_SAFETY slice is
 * structurally exempt; a REGULATED slice is capped regardless of its configured maximum.
 * Modelling this as a constraint rather than a large weight is deliberate: weights can be
 * outvoted by an unlucky combination of other factors, constraints cannot.
 */
export const COMPLIANCE_DEGRADATION_CEILING_PCT: Readonly<Record<ComplianceLevel, number>> =
  Object.freeze({
    [ComplianceLevel.NONE]: 100,
    [ComplianceLevel.INTERNAL]: 100,
    [ComplianceLevel.CONTRACTUAL]: 60,
    [ComplianceLevel.REGULATED]: 20,
    [ComplianceLevel.LIFE_SAFETY]: 0,
  });

export const CUSTOMER_IMPACT_SCORE: Readonly<Record<CustomerImpact, number>> = Object.freeze({
  [CustomerImpact.NONE]: 0,
  [CustomerImpact.INTERNAL_ONLY]: 20,
  [CustomerImpact.INDIRECT]: 45,
  [CustomerImpact.DIRECT]: 75,
  [CustomerImpact.SEVERE_EXTERNAL]: 100,
});

/**
 * Recovery tolerance drives two independent things:
 *
 *  `harmCurvature` (γ) — the exponent applied to normalised degradation depth in the harm
 *      function. γ > 1 makes harm superlinear, so the optimiser is pushed toward spreading
 *      shallow cuts across many slices instead of gutting one. A ZERO-tolerance department
 *      has γ = 3.0: the first 10 % of degradation is nearly free, the last 10 % is
 *      catastrophic. This single parameter is why the engine does not behave like a sort.
 *
 *  `recoveryWindowSeconds` — the maximum time the department can remain degraded before
 *      the decision must be revisited. Feeds decision duration and the recovery scheduler.
 */
export interface RecoveryToleranceProfile {
  readonly harmCurvature: number;
  readonly recoveryWindowSeconds: number;
  /** 0..100, higher = less tolerant. Contributes to the business priority score. */
  readonly intoleranceScore: number;
}

export const RECOVERY_TOLERANCE_PROFILE: Readonly<
  Record<RecoveryTolerance, RecoveryToleranceProfile>
> = Object.freeze({
  [RecoveryTolerance.ZERO]: { harmCurvature: 3.0, recoveryWindowSeconds: 30, intoleranceScore: 100 },
  [RecoveryTolerance.LOW]: { harmCurvature: 2.2, recoveryWindowSeconds: 120, intoleranceScore: 72 },
  [RecoveryTolerance.MODERATE]: {
    harmCurvature: 1.6,
    recoveryWindowSeconds: 600,
    intoleranceScore: 40,
  },
  [RecoveryTolerance.HIGH]: {
    harmCurvature: 1.15,
    recoveryWindowSeconds: 1800,
    intoleranceScore: 12,
  },
});

/* ------------------------------------------------------------------ */
/* Business Policy Engine — default weight vector                      */
/* ------------------------------------------------------------------ */

export interface PolicyWeightVector {
  readonly departmentCriticality: number;
  readonly businessImportance: number;
  readonly downtimeCost: number;
  readonly compliance: number;
  readonly customerImpact: number;
  readonly operationalImportance: number;
  readonly recoveryIntolerance: number;
}

/** Must sum to 1.0. Validated at policy-save time by `policy.validator.ts`. */
export const DEFAULT_POLICY_WEIGHTS: PolicyWeightVector = Object.freeze({
  departmentCriticality: 0.26,
  businessImportance: 0.16,
  downtimeCost: 0.2,
  compliance: 0.14,
  customerImpact: 0.12,
  operationalImportance: 0.07,
  recoveryIntolerance: 0.05,
});

export const POLICY_WEIGHT_KEYS = Object.keys(
  DEFAULT_POLICY_WEIGHTS,
) as readonly (keyof PolicyWeightVector)[];

/**
 * Downtime cost is expressed in currency per minute and is unbounded, so it cannot be fed
 * into a 0..100 score directly. We normalise it logarithmically against this reference
 * point: a department losing `DOWNTIME_COST_REFERENCE` per minute scores 50. Log scaling
 * prevents one extreme outlier from saturating the entire weight vector.
 */
export const DOWNTIME_COST_REFERENCE_PER_MINUTE = 1000;
export const DOWNTIME_COST_LOG_BASE = 10;

/* ------------------------------------------------------------------ */
/* Arbitration Engine tunables                                         */
/* ------------------------------------------------------------------ */

export const ArbitrationTunables = {
  /**
   * Granularity of the water-filling allocator, as a fraction of each slice's requested
   * demand. 0.005 = 0.5 % steps. Smaller = closer to the continuous optimum but more
   * iterations. Bounded by MAX_ALLOCATION_ITERATIONS.
   */
  DEGRADATION_QUANTUM: 0.005,

  /** Hard iteration ceiling so a pathological input can never stall the event loop. */
  MAX_ALLOCATION_ITERATIONS: 20_000,

  /**
   * Fairness memory: how far back historical degradation burden is accumulated when
   * computing the fairness multiplier.
   */
  FAIRNESS_LOOKBACK_SECONDS: 24 * 60 * 60,

  /**
   * λ — strength of the historical-fairness correction. Harm is multiplied by
   * `1 + λ · (relativeBurden − 1)`, clamped to [1/(1+λ), 1+λ]. At 0.6 a slice that has
   * absorbed twice the fleet-average degradation recently is ~60 % more "expensive" to
   * degrade again, which rotates the burden without ever overriding a hard constraint.
   */
  FAIRNESS_LAMBDA: 0.6,

  /**
   * SLA stress amplification. A slice already sitting at its SLA floor is more damaging to
   * cut further; harm is multiplied by `1 + SLA_STRESS_GAIN · stress` where stress ∈ [0,1].
   */
  SLA_STRESS_GAIN: 0.8,

  /** Minimum bandwidth any arbitrable slice may be reduced to, as a fraction of its */
  /** contractual `minGuaranteedMbps`. Guards against starving a slice into uselessness. */
  ABSOLUTE_FLOOR_FRACTION: 1.0,

  /**
   * Headroom the allocator targets below available capacity, so the network is not driven
   * to exactly 100 % (which oscillates). 0.03 = aim for 97 % utilisation post-arbitration.
   */
  TARGET_HEADROOM_FRACTION: 0.03,

  /** Confidence scoring inputs. */
  CONFIDENCE: {
    /** Max telemetry age, in seconds, before confidence starts falling. */
    FRESH_TELEMETRY_SECONDS: 15,
    /** Telemetry age at which the freshness term reaches zero. */
    STALE_TELEMETRY_SECONDS: 120,
    /** Weight of each confidence component; must sum to 1. */
    WEIGHTS: {
      harmMargin: 0.4,
      telemetryFreshness: 0.25,
      dataCompleteness: 0.2,
      constraintSlack: 0.15,
    },
  },

  /** Number of counterfactual strategies evaluated alongside the chosen plan. */
  ALTERNATIVES_TO_RETAIN: 3,
} as const;

/* ------------------------------------------------------------------ */
/* Contention detection                                                */
/* ------------------------------------------------------------------ */

export const ContentionTunables = {
  /**
   * Demand must exceed capacity by at least this fraction before a contention event is
   * raised. Prevents event storms from measurement jitter around the capacity line.
   */
  DETECTION_THRESHOLD_RATIO: 1.02,

  /** Consecutive samples above threshold required to confirm contention (debounce). */
  CONFIRMATION_SAMPLES: 2,

  /** Consecutive samples below threshold required to declare a contention resolved. */
  CLEARANCE_SAMPLES: 3,

  /** Minimum seconds between two arbitration runs for the same contention (anti-flap). */
  ARBITRATION_COOLDOWN_SECONDS: 20,

  /** Overload ratio → severity. Evaluated top-down; first match wins. */
  SEVERITY_THRESHOLDS: Object.freeze([
    { minRatio: 1.5, severity: 'CRITICAL' },
    { minRatio: 1.25, severity: 'SEVERE' },
    { minRatio: 1.1, severity: 'MODERATE' },
    { minRatio: 1.0, severity: 'MINOR' },
  ]),
} as const;

/* ------------------------------------------------------------------ */
/* Capacity monitor                                                    */
/* ------------------------------------------------------------------ */

export const CapacityTunables = {
  /** Utilisation above which the network is flagged as approaching saturation. */
  WARNING_UTILISATION: 0.85,
  CRITICAL_UTILISATION: 0.95,
  /** Rolling window used for utilisation trend / forecast, in samples. */
  TREND_WINDOW_SAMPLES: 20,
} as const;

/* ------------------------------------------------------------------ */
/* Retention                                                           */
/* ------------------------------------------------------------------ */

export const RetentionTunables = {
  TELEMETRY_RETENTION_HOURS: 24,
  CAPACITY_RETENTION_HOURS: 72,
  NOTIFICATION_RETENTION_DAYS: 30,
  /** Audit logs are legally significant and are never auto-pruned. */
  AUDIT_RETENTION_DAYS: Number.POSITIVE_INFINITY,
} as const;
