"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SliceSnapshotSchema = exports.HealthStatusSchema = exports.SliceStateSchema = exports.ProbeBatchReportSchema = exports.ProbeResultSchema = exports.SessionPatchRequestSchema = exports.JoinResponseSchema = exports.JoinRequestSchema = exports.BoundDeviceSchema = exports.SliceDemandControlSchema = exports.SliceLimitResultSchema = exports.SliceLimitUpdateSchema = exports.SliceStatsSchema = exports.SliceCatalogueSchema = exports.SliceCatalogueItemSchema = exports.CapacityResponseSchema = exports.HealthResponseSchema = exports.SlaTargetsSchema = exports.SliceProfileSchema = exports.SNssaiSchema = void 0;
exports.formatBandwidth = formatBandwidth;
exports.formatLatency = formatLatency;
exports.formatPercent = formatPercent;
const zod_1 = require("zod");
// ============================================================================
// Unit Formatter
// ============================================================================
function formatBandwidth(value, unit = 'kbps') {
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
function formatLatency(ms) {
    if (ms === null || ms === undefined || isNaN(ms))
        return '—';
    return `${Math.round(ms)} ms`;
}
function formatPercent(pct, decimals = 1) {
    if (pct === null || pct === undefined || isNaN(pct))
        return '—';
    return `${pct.toFixed(decimals)}%`;
}
// ============================================================================
// S-NSSAI & SLA Schemas
// ============================================================================
exports.SNssaiSchema = zod_1.z.object({
    sst: zod_1.z.number().int().min(1).max(255),
    sd: zod_1.z.string().regex(/^[0-9a-fA-F]{6}$/).optional(),
});
exports.SliceProfileSchema = zod_1.z.enum(['URLLC', 'eMBB', 'mMTC']);
exports.SlaTargetsSchema = zod_1.z.object({
    latencyMs: zod_1.z.number().positive(),
    jitterMs: zod_1.z.number().nonnegative(),
    lossPct: zod_1.z.number().min(0).max(100),
    minThroughputKbps: zod_1.z.number().nonnegative(),
    availabilityPct: zod_1.z.number().min(0).max(100),
});
// ============================================================================
// Southbound API Schemas (Port 9090)
// ============================================================================
exports.HealthResponseSchema = zod_1.z.object({
    ok: zod_1.z.boolean(),
    uptimeS: zod_1.z.number().nonnegative(),
    version: zod_1.z.string(),
});
exports.CapacityResponseSchema = zod_1.z.object({
    totalKbps: zod_1.z.number().positive(),
    reservedKbps: zod_1.z.number().nonnegative(),
    offeredKbps: zod_1.z.number().positive(),
    unit: zod_1.z.literal('kbps'),
    source: zod_1.z.string(),
    ispKbps: zod_1.z.number().optional(),
});
exports.SliceCatalogueItemSchema = zod_1.z.object({
    code: zod_1.z.string(),
    name: zod_1.z.string(),
    department: zod_1.z.string(),
    sNssai: exports.SNssaiSchema,
    profile: exports.SliceProfileSchema,
    baselineKbps: zod_1.z.number().positive(),
    floorKbps: zod_1.z.number().positive(),
    burstKbps: zod_1.z.number().positive(),
    currentLimitKbps: zod_1.z.number().positive(),
    slaTargets: exports.SlaTargetsSchema,
    joinCode: zod_1.z.string().min(4).max(12),
});
exports.SliceCatalogueSchema = zod_1.z.union([
    zod_1.z.array(exports.SliceCatalogueItemSchema),
    zod_1.z.object({ slices: zod_1.z.array(exports.SliceCatalogueItemSchema) }),
]);
exports.SliceStatsSchema = zod_1.z.object({
    code: zod_1.z.string(),
    atMs: zod_1.z.number(),
    demandKbps: zod_1.z.number().nonnegative(),
    limitKbps: zod_1.z.number().nonnegative(),
    usedKbps: zod_1.z.number().nonnegative(),
    droppedKbps: zod_1.z.number().nonnegative(),
    queueMs: zod_1.z.number().nonnegative(),
    latencyP50Ms: zod_1.z.number().nullable(),
    latencyP95Ms: zod_1.z.number().nullable(),
    jitterMs: zod_1.z.number().nullable(),
    lossPct: zod_1.z.number().min(0).max(100),
    availabilityPct: zod_1.z.number().min(0).max(100).nullable(),
    activeDevices: zod_1.z.number().int().nonnegative(),
    activeSessions: zod_1.z.number().int().nonnegative(),
    saturated: zod_1.z.boolean(),
});
exports.SliceLimitUpdateSchema = zod_1.z.object({
    limitKbps: zod_1.z.number().positive(),
    decisionId: zod_1.z.string().optional(),
    reason: zod_1.z.string().optional(),
});
exports.SliceLimitResultSchema = zod_1.z.object({
    applied: zod_1.z.boolean(),
    effectiveKbps: zod_1.z.number().nonnegative(),
});
exports.SliceDemandControlSchema = zod_1.z.object({
    kbps: zod_1.z.number().nonnegative(),
    mode: zod_1.z.enum(['local', 'internet']).optional(),
});
exports.BoundDeviceSchema = zod_1.z.object({
    deviceId: zod_1.z.string(),
    nickname: zod_1.z.string(),
    sourceIp: zod_1.z.string(),
    sliceCode: zod_1.z.string(),
    userAgent: zod_1.z.string().optional(),
    lastSeenMs: zod_1.z.number(),
    activeRateKbps: zod_1.z.number().nonnegative(),
    mode: zod_1.z.enum(['local', 'internet']),
    operatorControlEnabled: zod_1.z.boolean().default(false),
});
// ============================================================================
// Portal API Schemas (Port 8080)
// ============================================================================
exports.JoinRequestSchema = zod_1.z.object({
    code: zod_1.z.string().min(4).max(12),
    nickname: zod_1.z.string().min(1).max(32),
});
exports.JoinResponseSchema = zod_1.z.object({
    deviceId: zod_1.z.string(),
    slice: exports.SliceCatalogueItemSchema,
});
exports.SessionPatchRequestSchema = zod_1.z.object({
    rateKbps: zod_1.z.number().nonnegative(),
    mode: zod_1.z.enum(['local', 'internet']).optional(),
    operatorControlEnabled: zod_1.z.boolean().optional(),
});
exports.ProbeResultSchema = zod_1.z.object({
    seq: zod_1.z.number().int().nonnegative(),
    sentAtMs: zod_1.z.number(),
    recvAtMs: zod_1.z.number(),
    rttMs: zod_1.z.number().nonnegative(),
});
exports.ProbeBatchReportSchema = zod_1.z.object({
    deviceId: zod_1.z.string(),
    results: zod_1.z.array(exports.ProbeResultSchema),
});
exports.SliceStateSchema = zod_1.z.enum(['NORMAL', 'DEGRADED', 'PROTECTED']);
exports.HealthStatusSchema = zod_1.z.enum(['HEALTHY', 'DEGRADED', 'VIOLATING', 'CRITICAL', 'UNKNOWN']);
exports.SliceSnapshotSchema = zod_1.z.object({
    slice: exports.SliceCatalogueItemSchema,
    stats: exports.SliceStatsSchema,
    health: exports.HealthStatusSchema,
    state: exports.SliceStateSchema,
    degradationPct: zod_1.z.number(),
    latestDecision: zod_1.z.object({
        decisionId: zod_1.z.string(),
        reason: zod_1.z.string(),
        atMs: zod_1.z.number(),
    }).optional(),
    connectedDevices: zod_1.z.number().int().nonnegative(),
});
//# sourceMappingURL=index.js.map