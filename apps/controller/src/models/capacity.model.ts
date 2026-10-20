import { z } from 'zod';
import { auditableShape, isoDateTime, mbpsSchema } from './base.model';

/**
 * Capacity snapshot.
 *
 * Persisted at a lower rate than telemetry (it is one document per tick for the WHOLE
 * network, not one per slice) and retained longer, because capacity trends are the input
 * to planning conversations — "we have breached 90 % utilisation on 14 of the last 30
 * weekdays" is an argument for buying transport.
 */
export const CapacityLevel = {
  HEALTHY: 'HEALTHY',
  ELEVATED: 'ELEVATED',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
  OVERSUBSCRIBED: 'OVERSUBSCRIBED',
} as const;
export type CapacityLevel = (typeof CapacityLevel)[keyof typeof CapacityLevel];

export const CapacitySnapshotSchema = z.object({
  ...auditableShape,

  at: isoDateTime,
  atMs: z.number().int().nonnegative(),

  totalCapacityMbps: mbpsSchema,
  reservedCapacityMbps: mbpsSchema,
  offeredCapacityMbps: mbpsSchema,

  /** Sum of current allocations across arbitrable slices. */
  allocatedMbps: mbpsSchema,
  /** Sum of actual throughput. */
  usedMbps: mbpsSchema,
  /** Sum of what slices are TRYING to send — the number that can exceed capacity. */
  demandMbps: mbpsSchema,
  /** Offered capacity minus allocation. Negative means allocations are oversubscribed. */
  availableMbps: z.number(),

  /** usedMbps / offeredCapacityMbps. */
  utilisation: z.number().min(0),
  /** demandMbps / offeredCapacityMbps. Exceeds 1 during contention. */
  demandRatio: z.number().min(0),
  /** allocatedMbps / offeredCapacityMbps. */
  allocationRatio: z.number().min(0),

  level: z.nativeEnum(CapacityLevel),

  /** Least-squares slope of utilisation over the trend window, per sample. */
  utilisationTrend: z.number(),
  /** Projected utilisation one trend window ahead. Null when there is too little history. */
  projectedUtilisation: z.number().nullable(),

  activeSliceCount: z.number().int().nonnegative(),
  degradedSliceCount: z.number().int().nonnegative(),
  breachingSliceCount: z.number().int().nonnegative(),
});

export type CapacitySnapshot = z.infer<typeof CapacitySnapshotSchema>;

/** Live capacity view, held in memory and served to the dashboard every tick. */
export interface CapacityState {
  atMs: number;
  at: string;
  totalCapacityMbps: number;
  reservedCapacityMbps: number;
  offeredCapacityMbps: number;
  allocatedMbps: number;
  usedMbps: number;
  demandMbps: number;
  availableMbps: number;
  utilisation: number;
  demandRatio: number;
  allocationRatio: number;
  level: CapacityLevel;
  utilisationTrend: number;
  projectedUtilisation: number | null;
  activeSliceCount: number;
  degradedSliceCount: number;
  breachingSliceCount: number;
  /** True when total demand exceeds what the network can offer. */
  oversubscribed: boolean;
  /** How much demand exceeds offered capacity, in Mbps. Zero when not oversubscribed. */
  excessDemandMbps: number;
}

export const CapacityQuerySchema = z.object({
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});
