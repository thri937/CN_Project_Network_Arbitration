import { z } from 'zod';
import {
  CONTENTION_SEVERITIES,
  CONTENTION_STATUSES,
  ContentionSeverity,
  ContentionStatus,
} from '@/constants/enums';
import { auditableShape, isoDateTime, mbpsSchema } from './base.model';

/**
 * Contention event.
 *
 * A STATEFUL ENTITY, NOT A LOG LINE.
 * ==================================
 * The instinct is to record contention as an alert — a timestamped row saying "demand
 * exceeded capacity". That loses the two things an operator most needs during an incident:
 * how long this has been going on, and what has already been tried.
 *
 * So a contention event has a lifecycle and accumulates history:
 *
 *   DETECTED     demand has exceeded the threshold for enough consecutive samples
 *   ARBITRATING  the engine is computing or applying a plan
 *   MITIGATED    a plan was applied; demand still exceeds capacity but is being managed
 *   RESOLVED     demand fell below the threshold for enough consecutive samples
 *   UNRESOLVABLE no feasible plan exists — every slice is at its floor. Needs a human.
 *   EXPIRED      the event was superseded (e.g. slices were removed)
 *
 * `arbitrationCount` and `peakDemandRatio` are what let the UI say "this contention has
 * been running for 4 minutes, peaked at 143 % of capacity, and has had 2 arbitration
 * passes" — which is the difference between an alert and a usable incident view.
 */
export const ContentionEventSchema = z.object({
  ...auditableShape,

  status: z.enum(CONTENTION_STATUSES as [ContentionStatus, ...ContentionStatus[]]),
  severity: z.enum(CONTENTION_SEVERITIES as [ContentionSeverity, ...ContentionSeverity[]]),

  detectedAt: isoDateTime,
  detectedAtMs: z.number().int().nonnegative(),
  resolvedAt: isoDateTime.optional(),
  resolvedAtMs: z.number().int().nonnegative().optional(),
  /** Wall-clock duration once resolved. */
  durationSeconds: z.number().nonnegative().optional(),

  /* ---- Conditions at detection --------------------------------------- */
  offeredCapacityMbps: mbpsSchema,
  demandAtDetectionMbps: mbpsSchema,
  allocatedAtDetectionMbps: mbpsSchema,
  /** demand / offered capacity at detection. > 1 by construction. */
  demandRatioAtDetection: z.number().min(0),
  excessDemandMbps: mbpsSchema,

  /* ---- Running state -------------------------------------------------- */
  /** Worst demand ratio observed for the lifetime of this event. */
  peakDemandRatio: z.number().min(0),
  peakExcessMbps: mbpsSchema,
  /** Most recent observation, refreshed each tick while the event is open. */
  currentDemandRatio: z.number().min(0),
  currentExcessMbps: mbpsSchema,

  /** Slices contributing to the contention, captured at detection. */
  participants: z
    .array(
      z.object({
        sliceId: z.string().min(1),
        sliceCode: z.string().min(1),
        departmentId: z.string().min(1),
        demandMbps: mbpsSchema,
        allocatedMbps: mbpsSchema,
        /** This slice's share of total demand, 0–1. */
        demandShare: z.number().min(0).max(1),
      }),
    )
    .max(500),

  /* ---- Arbitration linkage -------------------------------------------- */
  arbitrationCount: z.number().int().nonnegative().default(0),
  lastArbitrationAt: isoDateTime.optional(),
  lastArbitrationAtMs: z.number().int().nonnegative().optional(),
  /** Decision ids produced for this contention, newest last. */
  decisionIds: z.array(z.string().min(1)).max(100).default([]),

  /** Populated when the engine could find no feasible plan. */
  unresolvableReason: z.string().max(2000).optional(),

  /** Consecutive below-threshold samples so far; drives the clearance decision. */
  clearanceProgress: z.number().int().nonnegative().default(0),
});

export type ContentionEvent = z.infer<typeof ContentionEventSchema>;

export type ContentionParticipant = ContentionEvent['participants'][number];

export const ContentionQuerySchema = z.object({
  status: z.enum(CONTENTION_STATUSES as [ContentionStatus, ...ContentionStatus[]]).optional(),
  severity: z.enum(CONTENTION_SEVERITIES as [ContentionSeverity, ...ContentionSeverity[]]).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

/** Statuses in which the event is still live and consuming operator attention. */
export const OPEN_CONTENTION_STATUSES: readonly ContentionStatus[] = Object.freeze([
  ContentionStatus.DETECTED,
  ContentionStatus.ARBITRATING,
  ContentionStatus.MITIGATED,
  ContentionStatus.UNRESOLVABLE,
]);

export function isOpen(event: Pick<ContentionEvent, 'status'>): boolean {
  return OPEN_CONTENTION_STATUSES.includes(event.status);
}

/**
 * Severity from the overload ratio.
 *
 * Thresholds are on the DEMAND ratio, not on utilisation: utilisation is capped at 1 by
 * definition (you cannot use more than you are allocated), so it carries no information
 * about how badly oversubscribed the network is. Demand is unbounded and is the only
 * signal that distinguishes "3 % over" from "70 % over".
 */
export function severityFor(demandRatio: number): ContentionSeverity {
  if (demandRatio >= 1.5) return ContentionSeverity.CRITICAL;
  if (demandRatio >= 1.25) return ContentionSeverity.SEVERE;
  if (demandRatio >= 1.1) return ContentionSeverity.MODERATE;
  return ContentionSeverity.MINOR;
}
