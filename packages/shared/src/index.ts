import { z } from 'zod';

// ============================================================================
// Unit Formatter
// ============================================================================

export function formatBandwidth(value: number | null | undefined, unit: string = 'kbps'): string {
  if (value === null || value === undefined || isNaN(value)) {
    return '—';
  }
  const cleanUnit = (unit || 'kbps').trim();
  // If unit is kbps, format neatly
  if (cleanUnit.toLowerCase() === 'kbps') {
    if (Math.abs(value) >= 1000) {
      return `${(value / 1000).toFixed(2)} Mbps`;
    }
    return `${Math.round(value)} kbps`;
  }
  if (cleanUnit.toLowerCase() === 'mbps') {
    if (Math.abs(value) >= 1000) {
      return `${(value / 1000).toFixed(2)} Gbps`;
    }
    return `${value.toFixed(1)} Mbps`;
  }
  return `${value.toFixed(1)} ${cleanUnit}`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || isNaN(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

export function formatPercent(pct: number | null | undefined, decimals = 1): string {
  if (pct === null || pct === undefined || isNaN(pct)) return '—';
  return `${pct.toFixed(decimals)}%`;
}

// ============================================================================
// S-NSSAI & SLA Schemas
// ============================================================================

export const SNssaiSchema = z.object({
  sst: z.number().int().min(1).max(255),
  sd: z.string().regex(/^[0-9a-fA-F]{6}$/).optional(),
});
export type SNssai = z.infer<typeof SNssaiSchema>;

export const SliceProfileSchema = z.enum(['URLLC', 'eMBB', 'mMTC']);
export type SliceProfile = z.infer<typeof SliceProfileSchema>;

export const SlaTargetsSchema = z.object({
  latencyMs: z.number().positive(),
  jitterMs: z.number().nonnegative(),
  lossPct: z.number().min(0).max(100),
  minThroughputKbps: z.number().nonnegative(),
  availabilityPct: z.number().min(0).max(100),
});
export type SlaTargets = z.infer<typeof SlaTargetsSchema>;

// ============================================================================
// Southbound API Schemas (Port 9090)
// ============================================================================

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  uptimeS: z.number().nonnegative(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const CapacityResponseSchema = z.object({
  totalKbps: z.number().positive(),
  reservedKbps: z.number().nonnegative(),
  offeredKbps: z.number().positive(),
  unit: z.literal('kbps'),
  source: z.string(),
  ispKbps: z.number().optional(),
});
export type CapacityResponse = z.infer<typeof CapacityResponseSchema>;

export const SliceCatalogueItemSchema = z.object({
  code: z.string(),
  name: z.string(),
  department: z.string(),
  sNssai: SNssaiSchema,
  profile: SliceProfileSchema,
  baselineKbps: z.number().positive(),
  floorKbps: z.number().positive(),
  burstKbps: z.number().positive(),
  currentLimitKbps: z.number().positive(),
  slaTargets: SlaTargetsSchema,
  joinCode: z.string().min(4).max(12),
});
export type SliceCatalogueItem = z.infer<typeof SliceCatalogueItemSchema>;

export const SliceCatalogueSchema = z.union([
  z.array(SliceCatalogueItemSchema),
  z.object({ slices: z.array(SliceCatalogueItemSchema) }),
]);
export type SliceCatalogue = z.infer<typeof SliceCatalogueSchema>;

export const SliceStatsSchema = z.object({
  code: z.string(),
  atMs: z.number(),
  demandKbps: z.number().nonnegative(),
  limitKbps: z.number().nonnegative(),
  usedKbps: z.number().nonnegative(),
  droppedKbps: z.number().nonnegative(),
  queueMs: z.number().nonnegative(),
  latencyP50Ms: z.number().nullable(),
  latencyP95Ms: z.number().nullable(),
  jitterMs: z.number().nullable(),
  lossPct: z.number().min(0).max(100),
  availabilityPct: z.number().min(0).max(100).nullable(),
  activeDevices: z.number().int().nonnegative(),
  activeSessions: z.number().int().nonnegative(),
  saturated: z.boolean(),
});
export type SliceStats = z.infer<typeof SliceStatsSchema>;

export const SliceLimitUpdateSchema = z.object({
  limitKbps: z.number().positive(),
  decisionId: z.string().optional(),
  reason: z.string().optional(),
});
export type SliceLimitUpdate = z.infer<typeof SliceLimitUpdateSchema>;

export const SliceLimitResultSchema = z.object({
  applied: z.boolean(),
  effectiveKbps: z.number().nonnegative(),
});
export type SliceLimitResult = z.infer<typeof SliceLimitResultSchema>;

export const SliceDemandControlSchema = z.object({
  kbps: z.number().nonnegative(),
  mode: z.enum(['local', 'internet']).optional(),
});
export type SliceDemandControl = z.infer<typeof SliceDemandControlSchema>;

export const BoundDeviceSchema = z.object({
  deviceId: z.string(),
  nickname: z.string(),
  sourceIp: z.string(),
  sliceCode: z.string(),
  userAgent: z.string().optional(),
  lastSeenMs: z.number(),
  activeRateKbps: z.number().nonnegative(),
  mode: z.enum(['local', 'internet']),
  operatorControlEnabled: z.boolean().default(false),
});
export type BoundDevice = z.infer<typeof BoundDeviceSchema>;

// ============================================================================
// Portal API Schemas (Port 8080)
// ============================================================================

export const JoinRequestSchema = z.object({
  code: z.string().min(4).max(12),
  nickname: z.string().min(1).max(32),
});
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

export const JoinResponseSchema = z.object({
  deviceId: z.string(),
  slice: SliceCatalogueItemSchema,
});
export type JoinResponse = z.infer<typeof JoinResponseSchema>;

export const SessionPatchRequestSchema = z.object({
  rateKbps: z.number().nonnegative(),
  mode: z.enum(['local', 'internet']).optional(),
  operatorControlEnabled: z.boolean().optional(),
});
export type SessionPatchRequest = z.infer<typeof SessionPatchRequestSchema>;

export const ProbeResultSchema = z.object({
  seq: z.number().int().nonnegative(),
  sentAtMs: z.number(),
  recvAtMs: z.number(),
  rttMs: z.number().nonnegative(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const ProbeBatchReportSchema = z.object({
  deviceId: z.string(),
  results: z.array(ProbeResultSchema),
});
export type ProbeBatchReport = z.infer<typeof ProbeBatchReportSchema>;

export const SliceStateSchema = z.enum(['NORMAL', 'DEGRADED', 'PROTECTED']);
export type SliceState = z.infer<typeof SliceStateSchema>;

export const HealthStatusSchema = z.enum(['HEALTHY', 'DEGRADED', 'VIOLATING', 'CRITICAL', 'UNKNOWN']);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const SliceSnapshotSchema = z.object({
  slice: SliceCatalogueItemSchema,
  stats: SliceStatsSchema,
  health: HealthStatusSchema,
  state: SliceStateSchema,
  degradationPct: z.number(),
  latestDecision: z.object({
    decisionId: z.string(),
    reason: z.string(),
    atMs: z.number(),
  }).optional(),
  connectedDevices: z.number().int().nonnegative(),
});
export type SliceSnapshot = z.infer<typeof SliceSnapshotSchema>;
