/**
 * React Query key factory.
 *
 * Every cache key in the application is minted here. Inline array literals scattered
 * through components are the standard way React Query caches silently fragment: one
 * component writes `['slices']`, another reads `['slices', undefined]`, and the socket
 * update lands on neither.
 *
 * Keys are hierarchical, so `invalidateQueries({ queryKey: queryKeys.slices.all() })`
 * invalidates every slice query including detail and filtered lists.
 */
export const queryKeys = {
  auth: {
    me: () => ['auth', 'me'] as const,
  },

  users: {
    all: () => ['users'] as const,
    list: (filters?: Record<string, unknown>) => ['users', 'list', filters ?? {}] as const,
    detail: (id: string) => ['users', 'detail', id] as const,
  },

  departments: {
    all: () => ['departments'] as const,
    list: (filters?: Record<string, unknown>) => ['departments', 'list', filters ?? {}] as const,
    detail: (id: string) => ['departments', 'detail', id] as const,
    summary: () => ['departments', 'summary'] as const,
  },

  policies: {
    all: () => ['policies'] as const,
    list: (filters?: Record<string, unknown>) => ['policies', 'list', filters ?? {}] as const,
    detail: (id: string) => ['policies', 'detail', id] as const,
    active: () => ['policies', 'active'] as const,
    effective: () => ['policies', 'effective'] as const,
  },

  slices: {
    all: () => ['slices'] as const,
    list: (filters?: Record<string, unknown>) => ['slices', 'list', filters ?? {}] as const,
    detail: (id: string) => ['slices', 'detail', id] as const,
    headroom: () => ['slices', 'headroom'] as const,
    topology: () => ['slices', 'topology'] as const,
  },

  telemetry: {
    all: () => ['telemetry'] as const,
    /** Written by BOTH the socket and the polling fallback — one key, one source of truth. */
    live: () => ['telemetry', 'live'] as const,
    liveSlice: (sliceId: string) => ['telemetry', 'live', sliceId] as const,
    provider: () => ['telemetry', 'provider'] as const,
    series: (sliceId: string, range?: Record<string, unknown>) =>
      ['telemetry', 'series', sliceId, range ?? {}] as const,
  },

  capacity: {
    all: () => ['capacity'] as const,
    current: () => ['capacity', 'current'] as const,
    series: (range?: Record<string, unknown>) => ['capacity', 'series', range ?? {}] as const,
  },

  contention: {
    all: () => ['contention'] as const,
    current: () => ['contention', 'current'] as const,
    list: (filters?: Record<string, unknown>) => ['contention', 'list', filters ?? {}] as const,
    detail: (id: string) => ['contention', 'detail', id] as const,
  },

  arbitration: {
    all: () => ['arbitration'] as const,
    list: (filters?: Record<string, unknown>) => ['arbitration', 'list', filters ?? {}] as const,
    detail: (id: string) => ['arbitration', 'detail', id] as const,
    recent: () => ['arbitration', 'recent'] as const,
    summary: (range?: Record<string, unknown>) => ['arbitration', 'summary', range ?? {}] as const,
    forContention: (contentionId: string) => ['arbitration', 'contention', contentionId] as const,
  },

  audit: {
    all: () => ['audit'] as const,
    list: (filters?: Record<string, unknown>) => ['audit', 'list', filters ?? {}] as const,
    detail: (id: string) => ['audit', 'detail', id] as const,
    timeline: (targetId: string) => ['audit', 'timeline', targetId] as const,
  },

  notifications: {
    all: () => ['notifications'] as const,
    list: (filters?: Record<string, unknown>) => ['notifications', 'list', filters ?? {}] as const,
    unreadCount: () => ['notifications', 'unread-count'] as const,
  },

  settings: {
    all: () => ['settings'] as const,
    current: () => ['settings', 'current'] as const,
    system: () => ['settings', 'system'] as const,
  },

  reports: {
    overview: (range?: Record<string, unknown>) => ['reports', 'overview', range ?? {}] as const,
  },
} as const;
