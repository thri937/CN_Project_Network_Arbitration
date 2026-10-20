import { del, get, getPage, patch, post } from './client';
import type {
  ArbitrationDecision,
  ArbitrationPlan,
  AuditLog,
  CapacityState,
  ContentionEvent,
  Department,
  LiveSliceState,
  NetworkSnapshot,
  Notification,
  Policy,
  PublicUser,
  ReportOverview,
  ResolvedPolicy,
  Session,
  Settings,
  Slice,
  SystemStatus,
  TelemetrySample,
} from '@/types/api';

/**
 * Typed API surface, one namespace per resource.
 *
 * Every URL in the application appears exactly once, here. Components and hooks call these
 * functions and never construct a path — which is what makes an API change a single-file
 * edit rather than a search-and-replace across the codebase.
 */

/* ------------------------------------------------------------------ */
export const authApi = {
  /** Exchange a provider ID token for a platform session. */
  createSession: (idToken: string) =>
    post<{ user: PublicUser; session: Session }>('/auth/session', { idToken }),

  /** Development sign-in. Mounted only when the backend runs the dev auth adapter. */
  devLogin: (email: string, displayName?: string) =>
    post<{ user: PublicUser; session: Session; warning: string }>('/auth/dev-login', {
      email,
      ...(displayName ? { displayName } : {}),
    }),

  me: () => get<PublicUser>('/auth/me'),

  logout: (everywhere = false) =>
    post<{ revokedEverywhere: boolean }>('/auth/logout', { everywhere }),
};

/* ------------------------------------------------------------------ */
export const usersApi = {
  list: (params?: { limit?: number; cursor?: string; role?: string; enabled?: boolean }) =>
    getPage<PublicUser>('/users', { params }),

  get: (id: string) => get<PublicUser>(`/users/${id}`),

  update: (id: string, body: { role?: string; enabled?: boolean; departmentScope?: string[] }) =>
    patch<PublicUser>(`/users/${id}`, body),

  updateOwnProfile: (body: { displayName?: string }) => patch<PublicUser>('/users/me', body),

  revokeSessions: (id: string) => post<null>(`/users/${id}/revoke-sessions`, {}),

  remove: (id: string) => del(`/users/${id}`),
};

/* ------------------------------------------------------------------ */
export const departmentsApi = {
  list: (params?: { limit?: number; cursor?: string; active?: boolean }) =>
    getPage<Department>('/departments', { params }),

  /** Unpaginated — department counts are in the tens and the UI needs them all at once. */
  listAll: async (): Promise<Department[]> => {
    const page = await getPage<Department>('/departments', { params: { limit: 200 } });
    return page.items;
  },

  get: (id: string) => get<Department>(`/departments/${id}`),

  summary: () =>
    get<
      {
        department: Department;
        sliceCount: number;
        allocatedMbps: number;
        degradedSliceCount: number;
        effectiveDegradationCeiling: number;
      }[]
    >('/departments/summary'),

  create: (body: Partial<Department>) => post<Department>('/departments', body),

  update: (id: string, body: Partial<Department>) => patch<Department>(`/departments/${id}`, body),

  remove: (id: string) => del(`/departments/${id}`),
};

/* ------------------------------------------------------------------ */
export const policiesApi = {
  list: (params?: { limit?: number; cursor?: string; status?: string }) =>
    getPage<Policy>('/policies', { params }),

  active: () => get<Policy>('/policies/active'),

  /** The fully resolved configuration the engine consumes — every override merged. */
  effective: () => get<ResolvedPolicy>('/policies/effective'),

  get: (id: string) => get<Policy>(`/policies/${id}`),

  create: (body: Partial<Policy>) => post<Policy>('/policies', body),

  update: (id: string, body: Partial<Policy>) => patch<Policy>(`/policies/${id}`, body),

  activate: (id: string) => post<Policy>(`/policies/${id}/activate`, {}),

  remove: (id: string) => del(`/policies/${id}`),
};

/* ------------------------------------------------------------------ */
export const slicesApi = {
  list: (params?: { limit?: number; cursor?: string; departmentId?: string; status?: string }) =>
    getPage<Slice>('/slices', { params }),

  listAll: async (): Promise<Slice[]> => {
    const page = await getPage<Slice>('/slices', { params: { limit: 200 } });
    return page.items;
  },

  get: (id: string) => get<Slice>(`/slices/${id}`),

  headroom: () =>
    get<{
      offeredCapacityMbps: number;
      committedFloorMbps: number;
      availableFloorMbps: number;
      committedBaselineMbps: number;
      baselineOversubscriptionRatio: number;
    }>('/slices/headroom'),

  topology: () =>
    get<
      {
        slice: Slice;
        department: {
          id: string;
          name: string;
          code: string;
          criticality: string;
          complianceLevel: string;
          site?: string;
        } | null;
      }[]
    >('/slices/topology'),

  create: (body: Partial<Slice>) => post<Slice>('/slices', body),

  update: (id: string, body: Partial<Slice>) => patch<Slice>(`/slices/${id}`, body),

  pause: (id: string, reason: string) => post<Slice>(`/slices/${id}/pause`, { reason }),

  resume: (id: string) => post<Slice>(`/slices/${id}/resume`, {}),

  remove: (id: string) => del<{ deleted: boolean; status?: string; reason?: string }>(`/slices/${id}`),
};

/* ------------------------------------------------------------------ */
export const telemetryApi = {
  /**
   * The live snapshot the control loop is acting on.
   *
   * `stale` is returned by the server rather than inferred from a timestamp on the client:
   * clock skew between browser and server would otherwise make a healthy feed look stale,
   * or worse, a stalled one look fresh.
   */
  live: () =>
    get<{ snapshot: NetworkSnapshot | null; snapshotAgeMs: number | null; stale: boolean }>(
      '/telemetry/live',
    ),

  liveSlice: (sliceId: string) => get<LiveSliceState>(`/telemetry/live/${sliceId}`),

  provider: () =>
    get<{
      name: string;
      capabilities: Record<string, boolean | number>;
      capacity: { totalMbps: number; reservedMbps: number; offeredMbps: number; source: string };
      health: { status: string; message?: string };
      simulation?: {
        provider: string;
        trackedSlices: number;
        sampleCount: number;
        globalLoadMultiplier: number;
        activeFaults: { sliceId: string; kind: string; ticksRemaining: number }[];
      };
    }>('/telemetry/provider'),

  series: (sliceId: string, params?: { from?: string; to?: string; limit?: number }) =>
    get<{ sliceId: string; fromMs: number; toMs: number; points: number; samples: TelemetrySample[] }>(
      `/telemetry/series/${sliceId}`,
      { params },
    ),

  injectFault: (sliceId: string, kind: string, durationTicks: number) =>
    post<{ sliceId: string; kind: string }>('/telemetry/faults', { sliceId, kind, durationTicks }),

  clearFault: (sliceId: string) => del(`/telemetry/faults/${sliceId}`),

  setLoad: (multiplier: number) =>
    post<{ globalLoadMultiplier: number }>('/telemetry/load', { multiplier }),
};

/* ------------------------------------------------------------------ */
export const capacityApi = {
  current: () =>
    get<{
      capacity: CapacityState | null;
      admission: {
        offeredCapacityMbps: number;
        committedFloorMbps: number;
        availableFloorMbps: number;
        committedBaselineMbps: number;
        baselineOversubscriptionRatio: number;
      };
      thresholds: { warningUtilisation: number; criticalUtilisation: number };
      available: boolean;
    }>('/capacity'),

  series: (params?: { from?: string; to?: string; limit?: number }) =>
    get<{
      fromMs: number;
      toMs: number;
      points: number;
      samples: (CapacityState & { id: string })[];
      summary: {
        peakUtilisation: number;
        meanUtilisation: number;
        peakDemandRatio: number;
        oversubscribedSamples: number;
        oversubscribedPercent: number;
      } | null;
    }>('/capacity/series', { params }),
};

/* ------------------------------------------------------------------ */
export const contentionApi = {
  current: () =>
    get<{
      event: ContentionEvent | null;
      open: boolean;
      arbitration: { allowed: boolean; reason?: string; waitSeconds?: number } | null;
      detector: {
        detectionThresholdRatio: number;
        confirmationSamples: number;
        clearanceSamples: number;
        arbitrationCooldownSeconds: number;
      };
    }>('/contention/current'),

  list: (params?: { limit?: number; cursor?: string; status?: string; severity?: string }) =>
    getPage<ContentionEvent>('/contention', { params }),

  get: (id: string) => get<ContentionEvent>(`/contention/${id}`),
};

/* ------------------------------------------------------------------ */
export const arbitrationApi = {
  list: (params?: { limit?: number; cursor?: string; outcome?: string; contentionId?: string }) =>
    getPage<ArbitrationDecision>('/arbitration', { params }),

  recent: () => get<ArbitrationDecision[]>('/arbitration/recent'),

  get: (id: string) => get<ArbitrationDecision>(`/arbitration/${id}`),

  forContention: (contentionId: string) =>
    get<ArbitrationDecision[]>(`/arbitration/contention/${contentionId}`),

  summary: (params?: { from?: string; to?: string }) =>
    get<{
      fromMs: number;
      toMs: number;
      total: number;
      byOutcome: Record<string, number>;
      totalBandwidthFreedMbps: number;
      meanConfidence: number;
      meanHarm: number;
      harmAvoidedVsPrioritySortPercent: number;
      degradationsByDepartment: {
        departmentId: string;
        departmentName: string;
        degradationCount: number;
        totalReducedMbps: number;
      }[];
    }>('/arbitration/summary', { params }),

  /** Compute a plan WITHOUT applying it. */
  simulate: () => post<{ plan: ArbitrationPlan; applied: false }>('/arbitration/simulate', {}),

  trigger: (dryRun = false) =>
    post<{ plan: ArbitrationPlan; decision: ArbitrationDecision | null; applied: boolean }>(
      '/arbitration/trigger',
      { dryRun },
    ),

  override: (id: string, reason: string, restoreAll = true) =>
    post<ArbitrationDecision>(`/arbitration/${id}/override`, { reason, restoreAll }),
};

/* ------------------------------------------------------------------ */
export const auditApi = {
  list: (params?: {
    limit?: number;
    cursor?: string;
    action?: string;
    actorId?: string;
    targetId?: string;
    from?: string;
    to?: string;
  }) => getPage<AuditLog>('/audit', { params }),

  get: (id: string) => get<AuditLog>(`/audit/${id}`),

  timeline: (targetId: string) =>
    get<{ targetId: string; entries: AuditLog[]; count: number }>(`/audit/timeline/${targetId}`),
};

/* ------------------------------------------------------------------ */
export const notificationsApi = {
  list: (params?: { limit?: number; unreadOnly?: boolean; severity?: string }) =>
    get<Notification[]>('/notifications', { params }),

  unreadCount: () => get<{ count: number }>('/notifications/unread-count'),

  markRead: (ids: string[]) => post<{ updated: number }>('/notifications/read', { ids }),
};

/* ------------------------------------------------------------------ */
export const settingsApi = {
  get: () => get<Settings>('/settings'),

  update: (body: Partial<Settings>) => patch<Settings>('/settings', body),

  system: () => get<SystemStatus>('/settings/system'),
};

export const reportsApi = {
  overview: (params?: { from?: string; to?: string }) =>
    get<ReportOverview>('/reports/overview', { params }),
};
