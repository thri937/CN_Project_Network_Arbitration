import type { ErrorCode } from '@/constants/errorCodes';

/**
 * Cross-cutting transport types.
 *
 * Every REST response in the platform is one of exactly two shapes. Clients can therefore
 * write a single response interceptor (`frontend/src/api/client.ts`) instead of
 * special-casing each endpoint.
 */

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: ResponseMeta;
}

export interface ApiFailure {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    correlationId: string;
    timestamp: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ResponseMeta {
  correlationId?: string;
  timestamp?: string;
  /** Present on collection endpoints. */
  page?: PageMeta;
  /** Server processing time in milliseconds — surfaced in the ops dashboard. */
  durationMs?: number;
  [key: string]: unknown;
}

export interface PageMeta {
  limit: number;
  returned: number;
  /** Opaque cursor for the next page; null when the collection is exhausted. */
  nextCursor: string | null;
  /** Only populated when the caller explicitly asks for a count — it costs a full scan. */
  total?: number;
}

/**
 * Cursor pagination.
 *
 * Offset pagination is not offered: Firestore charges per document read for skipped rows,
 * and offsets are unstable against a collection that receives telemetry writes every
 * two seconds. Cursors are stable and O(1).
 */
export interface PageRequest {
  limit: number;
  cursor?: string | undefined;
  orderBy?: string | undefined;
  direction?: SortDirection | undefined;
}

export type SortDirection = 'asc' | 'desc';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

/** A field-level equality/range filter passed from a controller down to a repository. */
export interface QueryFilter {
  field: string;
  op: FilterOperator;
  value: unknown;
}

export type FilterOperator =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'not-in'
  | 'array-contains'
  | 'array-contains-any';

export interface QuerySpec {
  filters?: QueryFilter[];
  orderBy?: { field: string; direction: SortDirection }[];
  limit?: number;
  cursor?: string;
}

/** Fields every persisted entity carries. Managed by the repository layer, never by hand. */
export interface AuditableEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  /**
   * Monotonic revision counter used for optimistic concurrency. A write that supplies a
   * stale `version` is rejected with CONCURRENT_MODIFICATION rather than silently
   * clobbering a concurrent operator's change.
   */
  version: number;
}

/** Payload accepted by repository writes — audit fields are supplied by the repository. */
export type CreateInput<T extends AuditableEntity> = Omit<
  T,
  'id' | 'createdAt' | 'updatedAt' | 'version'
> & { id?: string };

export type UpdateInput<T extends AuditableEntity> = Partial<
  Omit<T, 'id' | 'createdAt' | 'createdBy' | 'version'>
>;

/** Identity of whoever caused a write, threaded through services into audit records. */
export interface ActorContext {
  userId: string;
  email: string;
  role: string;
  displayName?: string;
  ip?: string;
  userAgent?: string;
  correlationId: string;
}

/** The synthetic actor used when a background job — not a human — causes a change. */
export const SYSTEM_ACTOR: ActorContext = Object.freeze({
  userId: 'system',
  email: 'system@arbitration.internal',
  role: 'SYSTEM',
  displayName: 'Arbitration Runtime',
  correlationId: 'system',
});

export function isSystemActor(actor: ActorContext): boolean {
  return actor.userId === SYSTEM_ACTOR.userId;
}
