import { z } from 'zod';
export declare function formatBandwidth(value: number | null | undefined, unit?: string): string;
export declare function formatLatency(ms: number | null | undefined): string;
export declare function formatPercent(pct: number | null | undefined, decimals?: number): string;
export declare const SNssaiSchema: z.ZodObject<{
    sst: z.ZodNumber;
    sd: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    sst: number;
    sd?: string | undefined;
}, {
    sst: number;
    sd?: string | undefined;
}>;
export type SNssai = z.infer<typeof SNssaiSchema>;
export declare const SliceProfileSchema: z.ZodEnum<["URLLC", "eMBB", "mMTC"]>;
export type SliceProfile = z.infer<typeof SliceProfileSchema>;
export declare const SlaTargetsSchema: z.ZodObject<{
    latencyMs: z.ZodNumber;
    jitterMs: z.ZodNumber;
    lossPct: z.ZodNumber;
    minThroughputKbps: z.ZodNumber;
    availabilityPct: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    latencyMs: number;
    jitterMs: number;
    lossPct: number;
    minThroughputKbps: number;
    availabilityPct: number;
}, {
    latencyMs: number;
    jitterMs: number;
    lossPct: number;
    minThroughputKbps: number;
    availabilityPct: number;
}>;
export type SlaTargets = z.infer<typeof SlaTargetsSchema>;
export declare const HealthResponseSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    uptimeS: z.ZodNumber;
    version: z.ZodString;
}, "strip", z.ZodTypeAny, {
    ok: boolean;
    uptimeS: number;
    version: string;
}, {
    ok: boolean;
    uptimeS: number;
    version: string;
}>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export declare const CapacityResponseSchema: z.ZodObject<{
    totalKbps: z.ZodNumber;
    reservedKbps: z.ZodNumber;
    offeredKbps: z.ZodNumber;
    unit: z.ZodLiteral<"kbps">;
    source: z.ZodString;
    ispKbps: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    totalKbps: number;
    reservedKbps: number;
    offeredKbps: number;
    unit: "kbps";
    source: string;
    ispKbps?: number | undefined;
}, {
    totalKbps: number;
    reservedKbps: number;
    offeredKbps: number;
    unit: "kbps";
    source: string;
    ispKbps?: number | undefined;
}>;
export type CapacityResponse = z.infer<typeof CapacityResponseSchema>;
export declare const SliceCatalogueItemSchema: z.ZodObject<{
    code: z.ZodString;
    name: z.ZodString;
    department: z.ZodString;
    sNssai: z.ZodObject<{
        sst: z.ZodNumber;
        sd: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        sst: number;
        sd?: string | undefined;
    }, {
        sst: number;
        sd?: string | undefined;
    }>;
    profile: z.ZodEnum<["URLLC", "eMBB", "mMTC"]>;
    baselineKbps: z.ZodNumber;
    floorKbps: z.ZodNumber;
    burstKbps: z.ZodNumber;
    currentLimitKbps: z.ZodNumber;
    slaTargets: z.ZodObject<{
        latencyMs: z.ZodNumber;
        jitterMs: z.ZodNumber;
        lossPct: z.ZodNumber;
        minThroughputKbps: z.ZodNumber;
        availabilityPct: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        latencyMs: number;
        jitterMs: number;
        lossPct: number;
        minThroughputKbps: number;
        availabilityPct: number;
    }, {
        latencyMs: number;
        jitterMs: number;
        lossPct: number;
        minThroughputKbps: number;
        availabilityPct: number;
    }>;
    joinCode: z.ZodString;
}, "strip", z.ZodTypeAny, {
    code: string;
    name: string;
    department: string;
    sNssai: {
        sst: number;
        sd?: string | undefined;
    };
    profile: "URLLC" | "eMBB" | "mMTC";
    baselineKbps: number;
    floorKbps: number;
    burstKbps: number;
    currentLimitKbps: number;
    slaTargets: {
        latencyMs: number;
        jitterMs: number;
        lossPct: number;
        minThroughputKbps: number;
        availabilityPct: number;
    };
    joinCode: string;
}, {
    code: string;
    name: string;
    department: string;
    sNssai: {
        sst: number;
        sd?: string | undefined;
    };
    profile: "URLLC" | "eMBB" | "mMTC";
    baselineKbps: number;
    floorKbps: number;
    burstKbps: number;
    currentLimitKbps: number;
    slaTargets: {
        latencyMs: number;
        jitterMs: number;
        lossPct: number;
        minThroughputKbps: number;
        availabilityPct: number;
    };
    joinCode: string;
}>;
export type SliceCatalogueItem = z.infer<typeof SliceCatalogueItemSchema>;
export declare const SliceCatalogueSchema: z.ZodUnion<[z.ZodArray<z.ZodObject<{
    code: z.ZodString;
    name: z.ZodString;
    department: z.ZodString;
    sNssai: z.ZodObject<{
        sst: z.ZodNumber;
        sd: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        sst: number;
        sd?: string | undefined;
    }, {
        sst: number;
        sd?: string | undefined;
    }>;
    profile: z.ZodEnum<["URLLC", "eMBB", "mMTC"]>;
    baselineKbps: z.ZodNumber;
    floorKbps: z.ZodNumber;
    burstKbps: z.ZodNumber;
    currentLimitKbps: z.ZodNumber;
    slaTargets: z.ZodObject<{
        latencyMs: z.ZodNumber;
        jitterMs: z.ZodNumber;
        lossPct: z.ZodNumber;
        minThroughputKbps: z.ZodNumber;
        availabilityPct: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        latencyMs: number;
        jitterMs: number;
        lossPct: number;
        minThroughputKbps: number;
        availabilityPct: number;
    }, {
        latencyMs: number;
        jitterMs: number;
        lossPct: number;
        minThroughputKbps: number;
        availabilityPct: number;
    }>;
    joinCode: z.ZodString;
}, "strip", z.ZodTypeAny, {
    code: string;
    name: string;
    department: string;
    sNssai: {
        sst: number;
        sd?: string | undefined;
    };
    profile: "URLLC" | "eMBB" | "mMTC";
    baselineKbps: number;
    floorKbps: number;
    burstKbps: number;
    currentLimitKbps: number;
    slaTargets: {
        latencyMs: number;
        jitterMs: number;
        lossPct: number;
        minThroughputKbps: number;
        availabilityPct: number;
    };
    joinCode: string;
}, {
    code: string;
    name: string;
    department: string;
    sNssai: {
        sst: number;
        sd?: string | undefined;
    };
    profile: "URLLC" | "eMBB" | "mMTC";
    baselineKbps: number;
    floorKbps: number;
    burstKbps: number;
    currentLimitKbps: number;
    slaTargets: {
        latencyMs: number;
        jitterMs: number;
        lossPct: number;
        minThroughputKbps: number;
        availabilityPct: number;
    };
    joinCode: string;
}>, "many">, z.ZodObject<{
    slices: z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        name: z.ZodString;
        department: z.ZodString;
        sNssai: z.ZodObject<{
            sst: z.ZodNumber;
            sd: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            sst: number;
            sd?: string | undefined;
        }, {
            sst: number;
            sd?: string | undefined;
        }>;
        profile: z.ZodEnum<["URLLC", "eMBB", "mMTC"]>;
        baselineKbps: z.ZodNumber;
        floorKbps: z.ZodNumber;
        burstKbps: z.ZodNumber;
        currentLimitKbps: z.ZodNumber;
        slaTargets: z.ZodObject<{
            latencyMs: z.ZodNumber;
            jitterMs: z.ZodNumber;
            lossPct: z.ZodNumber;
            minThroughputKbps: z.ZodNumber;
            availabilityPct: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        }, {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        }>;
        joinCode: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    }, {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    slices: {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    }[];
}, {
    slices: {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    }[];
}>]>;
export type SliceCatalogue = z.infer<typeof SliceCatalogueSchema>;
export declare const SliceStatsSchema: z.ZodObject<{
    code: z.ZodString;
    atMs: z.ZodNumber;
    demandKbps: z.ZodNumber;
    limitKbps: z.ZodNumber;
    usedKbps: z.ZodNumber;
    droppedKbps: z.ZodNumber;
    queueMs: z.ZodNumber;
    latencyP50Ms: z.ZodNullable<z.ZodNumber>;
    latencyP95Ms: z.ZodNullable<z.ZodNumber>;
    jitterMs: z.ZodNullable<z.ZodNumber>;
    lossPct: z.ZodNumber;
    availabilityPct: z.ZodNullable<z.ZodNumber>;
    activeDevices: z.ZodNumber;
    activeSessions: z.ZodNumber;
    saturated: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    code: string;
    jitterMs: number | null;
    lossPct: number;
    availabilityPct: number | null;
    atMs: number;
    demandKbps: number;
    limitKbps: number;
    usedKbps: number;
    droppedKbps: number;
    queueMs: number;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
    activeDevices: number;
    activeSessions: number;
    saturated: boolean;
}, {
    code: string;
    jitterMs: number | null;
    lossPct: number;
    availabilityPct: number | null;
    atMs: number;
    demandKbps: number;
    limitKbps: number;
    usedKbps: number;
    droppedKbps: number;
    queueMs: number;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
    activeDevices: number;
    activeSessions: number;
    saturated: boolean;
}>;
export type SliceStats = z.infer<typeof SliceStatsSchema>;
export declare const SliceLimitUpdateSchema: z.ZodObject<{
    limitKbps: z.ZodNumber;
    decisionId: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limitKbps: number;
    decisionId?: string | undefined;
    reason?: string | undefined;
}, {
    limitKbps: number;
    decisionId?: string | undefined;
    reason?: string | undefined;
}>;
export type SliceLimitUpdate = z.infer<typeof SliceLimitUpdateSchema>;
export declare const SliceLimitResultSchema: z.ZodObject<{
    applied: z.ZodBoolean;
    effectiveKbps: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    applied: boolean;
    effectiveKbps: number;
}, {
    applied: boolean;
    effectiveKbps: number;
}>;
export type SliceLimitResult = z.infer<typeof SliceLimitResultSchema>;
export declare const SliceDemandControlSchema: z.ZodObject<{
    kbps: z.ZodNumber;
    mode: z.ZodOptional<z.ZodEnum<["local", "internet"]>>;
}, "strip", z.ZodTypeAny, {
    kbps: number;
    mode?: "local" | "internet" | undefined;
}, {
    kbps: number;
    mode?: "local" | "internet" | undefined;
}>;
export type SliceDemandControl = z.infer<typeof SliceDemandControlSchema>;
export declare const BoundDeviceSchema: z.ZodObject<{
    deviceId: z.ZodString;
    nickname: z.ZodString;
    sourceIp: z.ZodString;
    sliceCode: z.ZodString;
    userAgent: z.ZodOptional<z.ZodString>;
    lastSeenMs: z.ZodNumber;
    activeRateKbps: z.ZodNumber;
    mode: z.ZodEnum<["local", "internet"]>;
    operatorControlEnabled: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    mode: "local" | "internet";
    deviceId: string;
    nickname: string;
    sourceIp: string;
    sliceCode: string;
    lastSeenMs: number;
    activeRateKbps: number;
    operatorControlEnabled: boolean;
    userAgent?: string | undefined;
}, {
    mode: "local" | "internet";
    deviceId: string;
    nickname: string;
    sourceIp: string;
    sliceCode: string;
    lastSeenMs: number;
    activeRateKbps: number;
    userAgent?: string | undefined;
    operatorControlEnabled?: boolean | undefined;
}>;
export type BoundDevice = z.infer<typeof BoundDeviceSchema>;
export declare const JoinRequestSchema: z.ZodObject<{
    code: z.ZodString;
    nickname: z.ZodString;
}, "strip", z.ZodTypeAny, {
    code: string;
    nickname: string;
}, {
    code: string;
    nickname: string;
}>;
export type JoinRequest = z.infer<typeof JoinRequestSchema>;
export declare const JoinResponseSchema: z.ZodObject<{
    deviceId: z.ZodString;
    slice: z.ZodObject<{
        code: z.ZodString;
        name: z.ZodString;
        department: z.ZodString;
        sNssai: z.ZodObject<{
            sst: z.ZodNumber;
            sd: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            sst: number;
            sd?: string | undefined;
        }, {
            sst: number;
            sd?: string | undefined;
        }>;
        profile: z.ZodEnum<["URLLC", "eMBB", "mMTC"]>;
        baselineKbps: z.ZodNumber;
        floorKbps: z.ZodNumber;
        burstKbps: z.ZodNumber;
        currentLimitKbps: z.ZodNumber;
        slaTargets: z.ZodObject<{
            latencyMs: z.ZodNumber;
            jitterMs: z.ZodNumber;
            lossPct: z.ZodNumber;
            minThroughputKbps: z.ZodNumber;
            availabilityPct: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        }, {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        }>;
        joinCode: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    }, {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    }>;
}, "strip", z.ZodTypeAny, {
    slice: {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    };
    deviceId: string;
}, {
    slice: {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    };
    deviceId: string;
}>;
export type JoinResponse = z.infer<typeof JoinResponseSchema>;
export declare const SessionPatchRequestSchema: z.ZodObject<{
    rateKbps: z.ZodNumber;
    mode: z.ZodOptional<z.ZodEnum<["local", "internet"]>>;
    operatorControlEnabled: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    rateKbps: number;
    mode?: "local" | "internet" | undefined;
    operatorControlEnabled?: boolean | undefined;
}, {
    rateKbps: number;
    mode?: "local" | "internet" | undefined;
    operatorControlEnabled?: boolean | undefined;
}>;
export type SessionPatchRequest = z.infer<typeof SessionPatchRequestSchema>;
export declare const ProbeResultSchema: z.ZodObject<{
    seq: z.ZodNumber;
    sentAtMs: z.ZodNumber;
    recvAtMs: z.ZodNumber;
    rttMs: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    seq: number;
    sentAtMs: number;
    recvAtMs: number;
    rttMs: number;
}, {
    seq: number;
    sentAtMs: number;
    recvAtMs: number;
    rttMs: number;
}>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
export declare const ProbeBatchReportSchema: z.ZodObject<{
    deviceId: z.ZodString;
    results: z.ZodArray<z.ZodObject<{
        seq: z.ZodNumber;
        sentAtMs: z.ZodNumber;
        recvAtMs: z.ZodNumber;
        rttMs: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        seq: number;
        sentAtMs: number;
        recvAtMs: number;
        rttMs: number;
    }, {
        seq: number;
        sentAtMs: number;
        recvAtMs: number;
        rttMs: number;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    deviceId: string;
    results: {
        seq: number;
        sentAtMs: number;
        recvAtMs: number;
        rttMs: number;
    }[];
}, {
    deviceId: string;
    results: {
        seq: number;
        sentAtMs: number;
        recvAtMs: number;
        rttMs: number;
    }[];
}>;
export type ProbeBatchReport = z.infer<typeof ProbeBatchReportSchema>;
export declare const SliceStateSchema: z.ZodEnum<["NORMAL", "DEGRADED", "PROTECTED"]>;
export type SliceState = z.infer<typeof SliceStateSchema>;
export declare const HealthStatusSchema: z.ZodEnum<["HEALTHY", "DEGRADED", "VIOLATING", "CRITICAL", "UNKNOWN"]>;
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export declare const SliceSnapshotSchema: z.ZodObject<{
    slice: z.ZodObject<{
        code: z.ZodString;
        name: z.ZodString;
        department: z.ZodString;
        sNssai: z.ZodObject<{
            sst: z.ZodNumber;
            sd: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            sst: number;
            sd?: string | undefined;
        }, {
            sst: number;
            sd?: string | undefined;
        }>;
        profile: z.ZodEnum<["URLLC", "eMBB", "mMTC"]>;
        baselineKbps: z.ZodNumber;
        floorKbps: z.ZodNumber;
        burstKbps: z.ZodNumber;
        currentLimitKbps: z.ZodNumber;
        slaTargets: z.ZodObject<{
            latencyMs: z.ZodNumber;
            jitterMs: z.ZodNumber;
            lossPct: z.ZodNumber;
            minThroughputKbps: z.ZodNumber;
            availabilityPct: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        }, {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        }>;
        joinCode: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    }, {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    }>;
    stats: z.ZodObject<{
        code: z.ZodString;
        atMs: z.ZodNumber;
        demandKbps: z.ZodNumber;
        limitKbps: z.ZodNumber;
        usedKbps: z.ZodNumber;
        droppedKbps: z.ZodNumber;
        queueMs: z.ZodNumber;
        latencyP50Ms: z.ZodNullable<z.ZodNumber>;
        latencyP95Ms: z.ZodNullable<z.ZodNumber>;
        jitterMs: z.ZodNullable<z.ZodNumber>;
        lossPct: z.ZodNumber;
        availabilityPct: z.ZodNullable<z.ZodNumber>;
        activeDevices: z.ZodNumber;
        activeSessions: z.ZodNumber;
        saturated: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        code: string;
        jitterMs: number | null;
        lossPct: number;
        availabilityPct: number | null;
        atMs: number;
        demandKbps: number;
        limitKbps: number;
        usedKbps: number;
        droppedKbps: number;
        queueMs: number;
        latencyP50Ms: number | null;
        latencyP95Ms: number | null;
        activeDevices: number;
        activeSessions: number;
        saturated: boolean;
    }, {
        code: string;
        jitterMs: number | null;
        lossPct: number;
        availabilityPct: number | null;
        atMs: number;
        demandKbps: number;
        limitKbps: number;
        usedKbps: number;
        droppedKbps: number;
        queueMs: number;
        latencyP50Ms: number | null;
        latencyP95Ms: number | null;
        activeDevices: number;
        activeSessions: number;
        saturated: boolean;
    }>;
    health: z.ZodEnum<["HEALTHY", "DEGRADED", "VIOLATING", "CRITICAL", "UNKNOWN"]>;
    state: z.ZodEnum<["NORMAL", "DEGRADED", "PROTECTED"]>;
    degradationPct: z.ZodNumber;
    latestDecision: z.ZodOptional<z.ZodObject<{
        decisionId: z.ZodString;
        reason: z.ZodString;
        atMs: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        atMs: number;
        decisionId: string;
        reason: string;
    }, {
        atMs: number;
        decisionId: string;
        reason: string;
    }>>;
    connectedDevices: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    slice: {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    };
    stats: {
        code: string;
        jitterMs: number | null;
        lossPct: number;
        availabilityPct: number | null;
        atMs: number;
        demandKbps: number;
        limitKbps: number;
        usedKbps: number;
        droppedKbps: number;
        queueMs: number;
        latencyP50Ms: number | null;
        latencyP95Ms: number | null;
        activeDevices: number;
        activeSessions: number;
        saturated: boolean;
    };
    health: "DEGRADED" | "HEALTHY" | "VIOLATING" | "CRITICAL" | "UNKNOWN";
    state: "NORMAL" | "DEGRADED" | "PROTECTED";
    degradationPct: number;
    connectedDevices: number;
    latestDecision?: {
        atMs: number;
        decisionId: string;
        reason: string;
    } | undefined;
}, {
    slice: {
        code: string;
        name: string;
        department: string;
        sNssai: {
            sst: number;
            sd?: string | undefined;
        };
        profile: "URLLC" | "eMBB" | "mMTC";
        baselineKbps: number;
        floorKbps: number;
        burstKbps: number;
        currentLimitKbps: number;
        slaTargets: {
            latencyMs: number;
            jitterMs: number;
            lossPct: number;
            minThroughputKbps: number;
            availabilityPct: number;
        };
        joinCode: string;
    };
    stats: {
        code: string;
        jitterMs: number | null;
        lossPct: number;
        availabilityPct: number | null;
        atMs: number;
        demandKbps: number;
        limitKbps: number;
        usedKbps: number;
        droppedKbps: number;
        queueMs: number;
        latencyP50Ms: number | null;
        latencyP95Ms: number | null;
        activeDevices: number;
        activeSessions: number;
        saturated: boolean;
    };
    health: "DEGRADED" | "HEALTHY" | "VIOLATING" | "CRITICAL" | "UNKNOWN";
    state: "NORMAL" | "DEGRADED" | "PROTECTED";
    degradationPct: number;
    connectedDevices: number;
    latestDecision?: {
        atMs: number;
        decisionId: string;
        reason: string;
    } | undefined;
}>;
export type SliceSnapshot = z.infer<typeof SliceSnapshotSchema>;
//# sourceMappingURL=index.d.ts.map