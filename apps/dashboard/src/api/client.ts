import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ApiFailure, ApiSuccess, Paginated, Session } from '@/types/api';

/**
 * HTTP client.
 *
 * ONE INTERCEPTOR PAIR DOES FOUR JOBS
 * ===================================
 *  1. attaches the bearer token
 *  2. unwraps the `{ success, data }` envelope, so callers receive `T` not `ApiSuccess<T>`
 *  3. normalises every failure into `ApiError`, so a component never inspects `err.response`
 *  4. refreshes a single expired session and replays the request
 *
 * Point 4 has the subtlety worth explaining. Several queries fire simultaneously on the
 * dashboard; when the access token expires they all 401 at once. Without coordination each
 * would independently call `/auth/refresh`, and every refresh after the first would present
 * a token that the previous refresh had already rotated — logging the user out mid-shift.
 *
 * `refreshInFlight` collapses concurrent refreshes into one promise that every waiting
 * request awaits.
 */

const API_PREFIX = import.meta.env.VITE_API_PREFIX ?? '/api/v1';
const STORAGE_KEY = 'arbitration.session';

/* ------------------------------------------------------------------ */
/* Error                                                               */
/* ------------------------------------------------------------------ */

/**
 * A normalised failure.
 *
 * `code` is the stable contract; `message` is for display and may be reworded server-side
 * at any time. UI logic branches on `code`.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level validation issues, when the failure was a schema rejection. */
  get fieldErrors(): { field: string; message: string }[] {
    if (this.code !== 'VALIDATION_FAILED' || !Array.isArray(this.details)) return [];
    return (this.details as { field: string; message: string }[]).filter(
      (d) => typeof d?.field === 'string',
    );
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/* ------------------------------------------------------------------ */
/* Session storage                                                     */
/* ------------------------------------------------------------------ */

export const sessionStore = {
  get(): Session | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      // Corrupt or unavailable storage must not break the app; treat as signed out.
      return null;
    }
  },

  set(session: Session): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      /* Private mode — the session simply does not survive a reload. */
    }
  },

  clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
};

/* ------------------------------------------------------------------ */
/* Instance                                                            */
/* ------------------------------------------------------------------ */

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

let refreshInFlight: Promise<Session | null> | null = null;
let onSessionExpired: (() => void) | null = null;

/** Registered by `AuthProvider` so an unrecoverable 401 can route to the sign-in screen. */
export function setSessionExpiredHandler(handler: () => void): void {
  onSessionExpired = handler;
}

const instance: AxiosInstance = axios.create({
  baseURL: API_PREFIX,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

instance.interceptors.request.use((config) => {
  const session = sessionStore.get();
  if (session?.accessToken) {
    config.headers.Authorization = `Bearer ${session.accessToken}`;
  }
  return config;
});

instance.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiFailure>) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status;
    const code = error.response?.data?.error?.code;

    /* ---- Transparent refresh, exactly once per request ---------------- */
    const isExpired = status === 401 && code === 'TOKEN_EXPIRED';
    const isRefreshCall = config?.url?.includes('/auth/refresh');

    if (isExpired && config && !config._retried && !isRefreshCall) {
      config._retried = true;

      // Collapse concurrent refreshes: the dashboard fires several queries at once, and
      // each independently rotating the refresh token would invalidate the others.
      refreshInFlight ??= performRefresh().finally(() => {
        refreshInFlight = null;
      });

      const session = await refreshInFlight;
      if (session) {
        config.headers.Authorization = `Bearer ${session.accessToken}`;
        return instance.request(config);
      }
    }

    /* ---- Unrecoverable auth failure ------------------------------------ */
    if (status === 401 && !isRefreshCall) {
      sessionStore.clear();
      onSessionExpired?.();
    }

    return Promise.reject(toApiError(error));
  },
);

async function performRefresh(): Promise<Session | null> {
  const current = sessionStore.get();
  if (!current?.refreshToken) return null;

  try {
    // A bare axios call, not `instance`: routing it through the interceptor would recurse.
    const response = await axios.post<ApiSuccess<{ session: Session }>>(
      `${API_PREFIX}/auth/refresh`,
      { refreshToken: current.refreshToken },
      { headers: { 'Content-Type': 'application/json' } },
    );

    const session = response.data.data.session;
    sessionStore.set(session);
    return session;
  } catch {
    sessionStore.clear();
    return null;
  }
}

function toApiError(error: AxiosError<ApiFailure>): ApiError {
  const payload = error.response?.data;

  if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
    return new ApiError(
      payload.error.code,
      payload.error.message,
      error.response?.status ?? 0,
      payload.error.details,
      payload.error.correlationId,
    );
  }

  // Network-level failure: no response at all. Distinguished from a server error because
  // the remedy differs — one is "check your connection", the other "the platform is down".
  if (error.code === 'ECONNABORTED') {
    return new ApiError('TIMEOUT', 'The request timed out. The platform may be under load.', 0);
  }
  if (!error.response) {
    return new ApiError('NETWORK_ERROR', 'Cannot reach the arbitration platform.', 0);
  }

  return new ApiError(
    'UNKNOWN',
    error.message || 'An unexpected error occurred',
    error.response.status,
  );
}

/* ------------------------------------------------------------------ */
/* Typed helpers                                                       */
/* ------------------------------------------------------------------ */

/** GET, unwrapped to `T`. */
export async function get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const response = await instance.get<ApiSuccess<T>>(url, config);
  return response.data.data;
}

/** GET a collection, returning items plus the pagination cursor from `meta.page`. */
export async function getPage<T>(url: string, config?: AxiosRequestConfig): Promise<Paginated<T>> {
  const response = await instance.get<ApiSuccess<T[]>>(url, config);
  return {
    items: response.data.data,
    nextCursor: response.data.meta?.page?.nextCursor ?? null,
    ...(response.data.meta?.page?.total !== undefined
      ? { total: response.data.meta.page.total }
      : {}),
  };
}

export async function post<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const response = await instance.post<ApiSuccess<T>>(url, body, config);
  return response.data.data;
}

export async function patch<T>(url: string, body?: unknown): Promise<T> {
  const response = await instance.patch<ApiSuccess<T>>(url, body);
  return response.data.data;
}

/**
 * DELETE.
 *
 * Typed as `T | null` because the API legitimately answers either way: a hard delete
 * returns 204, while a soft delete (a slice with arbitration history is terminated, not
 * removed) returns 200 with an explanatory body.
 */
export async function del<T = null>(url: string): Promise<T | null> {
  const response = await instance.delete<ApiSuccess<T> | ''>(url);
  if (response.status === 204 || !response.data) return null;
  return (response.data as ApiSuccess<T>).data;
}

export { instance as http };
