import { z } from 'zod';
import {
  ARBITRABLE_SLICE_STATUSES,
  HealthState,
  SLICE_PROFILES,
  SLICE_STATUSES,
  SliceProfile,
  SliceServiceType,
  SliceStatus,
} from '@/constants/enums';
import {
  auditableShape,
  descriptionSchema,
  displayNameSchema,
  isoDateTime,
  mbpsSchema,
  percentSchema,
  slugSchema,
  tagsSchema,
} from './base.model';

/**
 * Network slice — the unit of arbitration.
 *
 * 3GPP INTEROPERABILITY
 * =====================
 * `snssai` (SST + SD) is the standard Single Network Slice Selection Assistance
 * Information from TS 23.501, modelled exactly as Open5GS and free5GC represent it. Storing
 * it natively is what makes the eventual swap to a live core an ADAPTER change rather than
 * a data-model migration.
 *
 * `profile` and `sst` are carried for interoperability and reporting. They are NOT inputs
 * to arbitration. `tests/unit/arbitration.invariants.test.ts` asserts that permuting every
 * slice's profile leaves the arbitration outcome byte-identical — that assertion is the
 * executable form of this platform's central claim.
 */

/* ------------------------------------------------------------------ */
/* Sub-schemas                                                         */
/* ------------------------------------------------------------------ */

export const SnssaiSchema = z.object({
  /** Slice/Service Type, 0–255. 1=eMBB, 2=URLLC, 3=MIoT, 4=V2X. */
  sst: z.number().int().min(0).max(255),
  /** Slice Differentiator: 6 hex digits, or absent. */
  sd: z
    .string()
    .regex(/^[0-9A-Fa-f]{6}$/, 'must be exactly 6 hexadecimal digits')
    .optional(),
});

export type Snssai = z.infer<typeof SnssaiSchema>;

/**
 * Contractual service-level targets.
 *
 * These are what the slice PROMISES its department. The arbitration engine reads them to
 * compute SLA stress — how close a slice already is to breaching — which amplifies the
 * harm of degrading it further. A slice comfortably inside its targets is a cheaper place
 * to take bandwidth from than one already at the edge.
 */
export const SlaTargetsSchema = z.object({
  maxLatencyMs: z.number().positive().max(10_000),
  maxJitterMs: z.number().nonnegative().max(1000),
  maxPacketLossPercent: z.number().min(0).max(100),
  minThroughputMbps: mbpsSchema,
  /** Contractual availability, e.g. 99.99. */
  availabilityPercent: z.number().min(0).max(100).default(99.9),
});

export type SlaTargets = z.infer<typeof SlaTargetsSchema>;

/**
 * The currently applied degradation, written by the allocation manager and cleared on
 * recovery. Null/absent means the slice runs at its baseline allocation.
 */
export const ActiveDegradationSchema = z.object({
  decisionId: z.string().min(1),
  contentionId: z.string().min(1),
  appliedAt: isoDateTime,
  expiresAt: isoDateTime,
  /** Percentage reduction from `baselineAllocatedMbps`. */
  percent: percentSchema,
  reducedMbps: mbpsSchema,
  reason: z.string().max(2000),
  /** Business priority score at the moment of the decision, retained for the UI. */
  businessScore: z.number().min(0).max(100),
});

export type ActiveDegradation = z.infer<typeof ActiveDegradationSchema>;

/**
 * Rolling degradation burden, maintained by the allocation manager.
 *
 * This is the memory the arbitration engine's FAIRNESS term reads. Without it the engine
 * would be memoryless and would degrade the same unlucky slice on every contention event,
 * because the same inputs always produce the same answer. Persisting the burden is what
 * lets the algorithm rotate the pain across departments over time.
 */
export const DegradationHistorySchema = z.object({
  totalEvents: z.number().int().nonnegative().default(0),
  /** Total seconds spent degraded, all time. */
  cumulativeDegradedSeconds: z.number().nonnegative().default(0),
  /**
   * Σ (degradation fraction × seconds held), over the fairness lookback window.
   * A single measure combining depth and duration — 50 % for 10 min and 25 % for 20 min
   * represent the same burden, which is the intuitively fair comparison.
   */
  burdenScore: z.number().nonnegative().default(0),
  lastDegradedAt: isoDateTime.optional(),
  lastRecoveredAt: isoDateTime.optional(),
  /** Rolling window entries, pruned by the recovery job. */
  recentEvents: z
    .array(
      z.object({
        at: isoDateTime,
        atMs: z.number().int().nonnegative(),
        percent: percentSchema,
        durationSeconds: z.number().nonnegative(),
        decisionId: z.string().min(1),
      }),
    )
    .max(200)
    .default([]),
});

export type DegradationHistory = z.infer<typeof DegradationHistorySchema>;

/* ------------------------------------------------------------------ */
/* Entity                                                              */
/* ------------------------------------------------------------------ */

export const SliceSchema = z.object({
  ...auditableShape,

  name: displayNameSchema,
  /** Stable machine key, unique across the deployment. */
  code: slugSchema,
  description: descriptionSchema,

  departmentId: z.string().min(1),

  /* ---- 3GPP identity (interoperability only — never read by arbitration) ---- */
  snssai: SnssaiSchema,
  profile: z.enum(SLICE_PROFILES as [SliceProfile, ...SliceProfile[]]),

  /* ---- Capacity ------------------------------------------------------ */

  /**
   * Bandwidth the slice is entitled to when the network is not contended. Restored on
   * recovery. Degradation NEVER writes here — that is the whole reason it is separate from
   * `allocatedMbps`: without a stored baseline, two successive degradations would compound
   * and the slice could never be returned to its contracted level.
   */
  baselineAllocatedMbps: mbpsSchema,

  /** Bandwidth currently granted. Equal to the baseline unless degraded. */
  allocatedMbps: mbpsSchema,

  /**
   * Contractual floor. Arbitration may never reduce a slice below this, and the sum across
   * all arbitrable slices may never exceed offered capacity — see `SliceService` admission
   * control. If that sum ever exceeded capacity, arbitration would be infeasible BY
   * CONSTRUCTION and the platform would be permanently unable to resolve contention.
   */
  minGuaranteedMbps: mbpsSchema,

  /** Ceiling the slice may burst to when spare capacity exists. */
  maxBurstMbps: mbpsSchema,

  slaTargets: SlaTargetsSchema,

  /* ---- Runtime state -------------------------------------------------- */

  status: z.enum(SLICE_STATUSES as [SliceStatus, ...SliceStatus[]]),
  health: z.nativeEnum(HealthState).default(HealthState.UNKNOWN),
  /** 0–100 composite health, computed by the telemetry service. */
  healthScore: z.number().min(0).max(100).default(100),

  activeDegradation: ActiveDegradationSchema.optional(),
  degradationHistory: DegradationHistorySchema.default({
    totalEvents: 0,
    cumulativeDegradedSeconds: 0,
    burdenScore: 0,
    recentEvents: [],
  }),

  pausedAt: isoDateTime.optional(),
  pausedReason: z.string().max(500).optional(),
  activatedAt: isoDateTime.optional(),

  /* ---- Topology & presentation ---------------------------------------- */

  /** Site or coverage area, drawn on the network topology view. */
  site: z.string().trim().max(120).optional(),
  /** Free-form endpoint identifiers (gNB ids, UPF names) for a real deployment. */
  endpoints: z.array(z.string().max(120)).max(50).default([]),
  tags: tagsSchema,

  /**
   * Deterministic seed for the synthetic telemetry generator, so a slice produces a
   * reproducible traffic pattern across restarts. Ignored by real telemetry adapters.
   */
  telemetrySeed: z.number().int().nonnegative().optional(),
});

export type Slice = z.infer<typeof SliceSchema>;

/* ------------------------------------------------------------------ */
/* API payloads                                                        */
/* ------------------------------------------------------------------ */

const sliceWritableShape = {
  name: displayNameSchema,
  description: descriptionSchema,
  departmentId: z.string().min(1),
  snssai: SnssaiSchema,
  profile: z.enum(SLICE_PROFILES as [SliceProfile, ...SliceProfile[]]),
  baselineAllocatedMbps: mbpsSchema.pipe(z.number().positive()),
  minGuaranteedMbps: mbpsSchema,
  maxBurstMbps: mbpsSchema.pipe(z.number().positive()),
  slaTargets: SlaTargetsSchema,
  site: z.string().trim().max(120).optional(),
  endpoints: z.array(z.string().max(120)).max(50).optional(),
  tags: z.array(slugSchema).max(20).optional(),
} as const;

export const CreateSliceSchema = z
  .object({
    ...sliceWritableShape,
    code: slugSchema.optional(),
  })
  .strict()
  .superRefine(assertBandwidthOrdering);

export const UpdateSliceSchema = z
  .object(sliceWritableShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be supplied',
  })
  .superRefine(assertBandwidthOrdering);

export type CreateSlicePayload = z.infer<typeof CreateSliceSchema>;
export type UpdateSlicePayload = z.infer<typeof UpdateSliceSchema>;

export const PauseSliceSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

export const SliceListQuerySchema = z.object({
  departmentId: z.string().min(1).optional(),
  status: z.enum(SLICE_STATUSES as [SliceStatus, ...SliceStatus[]]).optional(),
  profile: z.enum(SLICE_PROFILES as [SliceProfile, ...SliceProfile[]]).optional(),
  health: z.nativeEnum(HealthState).optional(),
  degradedOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

/**
 * Cross-field rule: `minGuaranteed ≤ baseline ≤ maxBurst`.
 *
 * Violating it produces a slice the arbitration engine cannot reason about — a floor above
 * the allocation means the slice is already in breach before any contention occurs.
 */
function assertBandwidthOrdering(
  value: { minGuaranteedMbps?: number; baselineAllocatedMbps?: number; maxBurstMbps?: number },
  ctx: z.RefinementCtx,
): void {
  const { minGuaranteedMbps: min, baselineAllocatedMbps: base, maxBurstMbps: burst } = value;

  if (min !== undefined && base !== undefined && min > base) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minGuaranteedMbps'],
      message: `Guaranteed minimum (${min} Mbps) cannot exceed the baseline allocation (${base} Mbps)`,
    });
  }

  if (base !== undefined && burst !== undefined && base > burst) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxBurstMbps'],
      message: `Burst ceiling (${burst} Mbps) cannot be below the baseline allocation (${base} Mbps)`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle state machine                                             */
/* ------------------------------------------------------------------ */

/**
 * Permitted status transitions.
 *
 * Encoded as data rather than as a chain of `if` statements so the machine can be shown in
 * documentation, asserted over exhaustively in tests, and extended without touching
 * control flow. An unlisted transition is rejected.
 */
export const SLICE_TRANSITIONS: Readonly<Record<SliceStatus, readonly SliceStatus[]>> =
  Object.freeze({
    [SliceStatus.PROVISIONING]: [SliceStatus.ACTIVE, SliceStatus.TERMINATED],
    [SliceStatus.ACTIVE]: [
      SliceStatus.DEGRADED,
      SliceStatus.PAUSED,
      SliceStatus.TERMINATED,
    ],
    // A degraded slice may be paused (an operator taking it out of service) or recover.
    [SliceStatus.DEGRADED]: [
      SliceStatus.RECOVERING,
      SliceStatus.ACTIVE,
      SliceStatus.PAUSED,
      SliceStatus.TERMINATED,
    ],
    // Recovery can be interrupted by fresh contention and fall back to DEGRADED.
    [SliceStatus.RECOVERING]: [
      SliceStatus.ACTIVE,
      SliceStatus.DEGRADED,
      SliceStatus.PAUSED,
      SliceStatus.TERMINATED,
    ],
    [SliceStatus.PAUSED]: [SliceStatus.ACTIVE, SliceStatus.TERMINATED],
    // Terminal.
    [SliceStatus.TERMINATED]: [],
  });

export function canTransition(from: SliceStatus, to: SliceStatus): boolean {
  return SLICE_TRANSITIONS[from].includes(to);
}

/** True when the slice consumes capacity and participates in arbitration. */
export function isArbitrable(slice: Pick<Slice, 'status'>): boolean {
  return ARBITRABLE_SLICE_STATUSES.includes(slice.status);
}

/* ------------------------------------------------------------------ */
/* Derived values                                                      */
/* ------------------------------------------------------------------ */

/**
 * Headroom available for degradation, in Mbps, before hitting the contractual floor.
 * The arbitration engine intersects this with the department's compliance ceiling.
 */
export function degradableHeadroomMbps(slice: Slice): number {
  return Math.max(0, slice.allocatedMbps - slice.minGuaranteedMbps);
}

/** Current degradation depth as a fraction of the baseline, in [0,1]. */
export function currentDegradationFraction(slice: Slice): number {
  if (slice.baselineAllocatedMbps <= 0) return 0;
  return Math.max(0, 1 - slice.allocatedMbps / slice.baselineAllocatedMbps);
}

export function deriveSliceCode(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Default S-NSSAI SST for a profile, used when a caller omits it. */
export const PROFILE_TO_SST: Readonly<Record<SliceProfile, SliceServiceType>> = Object.freeze({
  [SliceProfile.EMBB]: SliceServiceType.EMBB,
  [SliceProfile.URLLC]: SliceServiceType.URLLC,
  [SliceProfile.MMTC]: SliceServiceType.MIOT,
  [SliceProfile.V2X]: SliceServiceType.V2X,
});
