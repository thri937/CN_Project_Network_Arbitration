import { z } from 'zod';
import { HealthState } from '@/constants/enums';
import { auditableShape, isoDateTime, mbpsSchema, percentSchema } from './base.model';

/**
 * Persisted telemetry sample.
 *
 * WRITE VOLUME IS THE DESIGN CONSTRAINT
 * =====================================
 * At a 2-second tick across 20 slices this collection would receive 864,000 documents a
 * day. Two mitigations, both deliberate:
 *
 *  1. `TELEMETRY_PERSIST_EVERY_N_TICKS` — the live control loop runs at full rate in
 *     memory; only every Nth sample is persisted. Arbitration reads the in-memory snapshot,
 *     never the collection, so throttling storage costs the control loop nothing. What is
 *     persisted exists for charts and post-incident analysis, where 10-second resolution is
 *     ample.
 *
 *  2. `jobs/retention.job.ts` prunes beyond `TELEMETRY_RETENTION_HOURS`.
 *
 * `atMs` is stored alongside the ISO timestamp because every query against this collection
 * is a time range, and a numeric comparison is both index-friendly and free of string
 * parsing in the hot path.
 */
export const TelemetrySampleSchema = z.object({
  ...auditableShape,

  sliceId: z.string().min(1),
  sliceCode: z.string().min(1),
  departmentId: z.string().min(1),

  at: isoDateTime,
  atMs: z.number().int().nonnegative(),

  demandMbps: mbpsSchema,
  allocatedMbps: mbpsSchema,
  usedMbps: mbpsSchema,
  utilisation: z.number().min(0),

  latencyMs: z.number().nonnegative(),
  jitterMs: z.number().nonnegative(),
  packetLossPercent: percentSchema,

  cpuPercent: percentSchema,
  memoryPercent: percentSchema,
  activeSessions: z.number().int().nonnegative(),

  health: z.nativeEnum(HealthState),
  healthScore: z.number().min(0).max(100),

  /** Which provider produced this sample — essential when comparing across a migration. */
  source: z.string().max(64),
});

export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>;

/* ------------------------------------------------------------------ */
/* Live snapshot (in-memory, never persisted)                          */
/* ------------------------------------------------------------------ */

/**
 * The current state of one slice, as the control loop sees it.
 *
 * This is the shape the capacity monitor, contention detector and arbitration engine
 * consume. It is held in memory and refreshed every tick; nothing in the control loop reads
 * the telemetry collection, which is what keeps arbitration latency independent of
 * datastore performance.
 */
export interface LiveSliceState {
  sliceId: string;
  sliceCode: string;
  sliceName: string;
  departmentId: string;

  demandMbps: number;
  allocatedMbps: number;
  baselineAllocatedMbps: number;
  minGuaranteedMbps: number;
  usedMbps: number;
  utilisation: number;

  latencyMs: number;
  jitterMs: number;
  packetLossPercent: number;
  cpuPercent: number;
  memoryPercent: number;
  activeSessions: number;

  health: HealthState;
  healthScore: number;
  /** 0–1; how close the slice is to breaching its SLA. Amplifies arbitration harm. */
  slaStress: number;
  breaches: string[];

  status: string;
  /** Epoch ms of the observation. Feeds arbitration confidence via telemetry freshness. */
  observedAtMs: number;
}

/** One complete observation of the network. */
export interface NetworkSnapshot {
  atMs: number;
  at: string;
  slices: LiveSliceState[];
  totalDemandMbps: number;
  totalAllocatedMbps: number;
  totalUsedMbps: number;
  offeredCapacityMbps: number;
  source: string;
  /** Sequence number since process start; used to detect a stalled telemetry loop. */
  tick: number;
}

/* ------------------------------------------------------------------ */
/* Query schemas                                                       */
/* ------------------------------------------------------------------ */

export const TelemetryQuerySchema = z.object({
  sliceId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

export type TelemetryQuery = z.infer<typeof TelemetryQuerySchema>;

export const InjectFaultSchema = z
  .object({
    sliceId: z.string().min(1),
    kind: z.enum(['DEMAND_SURGE', 'LINK_DEGRADATION', 'COMPUTE_SATURATION']),
    durationTicks: z.number().int().min(1).max(3600).default(30),
  })
  .strict();

export const SetGlobalLoadSchema = z
  .object({ multiplier: z.number().min(0.1).max(10) })
  .strict();
