import type { FilterOperator, QueryFilter, SortDirection } from '@/types/common';
import { ValidationError } from '@/utils/errors';

/**
 * Query primitives shared by both datastore adapters.
 *
 * Two adapters implementing filtering, sorting and cursor encoding independently is how
 * you get a system where `GET /slices?status=ACTIVE` silently returns different results in
 * development and production. Everything driver-neutral lives here so the contract test
 * suite genuinely proves equivalence.
 */

/* ------------------------------------------------------------------ */
/* Cursors                                                             */
/* ------------------------------------------------------------------ */

export interface CursorPayload {
  /** Values of the ordering fields for the last row of the previous page. */
  values: unknown[];
  /** Document id, always the final tiebreaker so ordering is total. */
  id: string;
  /** Guards against a cursor issued under a different sort being replayed. */
  sortKey: string;
}

/** Stable, order-sensitive fingerprint of a sort specification. */
export function sortFingerprint(orderBy: { field: string; direction: SortDirection }[]): string {
  return orderBy.map((o) => `${o.field}:${o.direction}`).join('|');
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode and validate a cursor.
 *
 * A cursor is client-supplied input and therefore untrusted. It is rejected — rather than
 * coerced — when it is unparseable or was issued for a different sort order, because
 * silently ignoring a mismatched cursor produces duplicated and skipped rows that are
 * almost impossible to diagnose from the client side.
 */
export function decodeCursor(cursor: string, expectedSortKey: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('Pagination cursor is malformed', { field: 'cursor' });
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as CursorPayload).values) ||
    typeof (parsed as CursorPayload).id !== 'string' ||
    typeof (parsed as CursorPayload).sortKey !== 'string'
  ) {
    throw new ValidationError('Pagination cursor is malformed', { field: 'cursor' });
  }

  const payload = parsed as CursorPayload;
  if (payload.sortKey !== expectedSortKey) {
    throw new ValidationError(
      'Pagination cursor was issued for a different sort order; restart from the first page',
      { field: 'cursor', expected: expectedSortKey, received: payload.sortKey },
    );
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* Ordering                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_ORDER: { field: string; direction: SortDirection }[] = [
  { field: 'createdAt', direction: 'desc' },
];

/**
 * Append `id` as the final sort key unless already present.
 *
 * Without a unique tiebreaker, two documents sharing a `createdAt` value have an
 * unspecified relative order, and a cursor pointing at one of them can skip or repeat the
 * other. Telemetry rows written in the same millisecond make this a certainty, not an edge
 * case.
 */
export function withTotalOrdering(
  orderBy: { field: string; direction: SortDirection }[] | undefined,
): { field: string; direction: SortDirection }[] {
  const base = orderBy && orderBy.length > 0 ? [...orderBy] : [...DEFAULT_ORDER];
  if (!base.some((o) => o.field === 'id')) {
    base.push({ field: 'id', direction: base[base.length - 1]?.direction ?? 'desc' });
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Field access                                                        */
/* ------------------------------------------------------------------ */

/** Read a possibly-nested field via dot notation (`slaTargets.maxLatencyMs`). */
export function readPath(source: unknown, path: string): unknown {
  if (!path.includes('.')) {
    return typeof source === 'object' && source !== null
      ? (source as Record<string, unknown>)[path]
      : undefined;
  }
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* Comparison & filtering (in-memory driver, and cursor seeking)        */
/* ------------------------------------------------------------------ */

/**
 * Total order over heterogeneous values, matching Firestore's documented type ordering:
 * null < boolean < number < string < array < object. Establishing the same ordering in
 * both drivers is what keeps paginated results identical across environments.
 */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;

  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;

  switch (rankA) {
    case 0: // null / undefined
      return 0;
    case 1: // boolean
      return (a ? 1 : 0) - (b ? 1 : 0);
    case 2: // number
      return (a as number) - (b as number);
    case 3: // string
      return (a as string).localeCompare(b as string, 'en', { numeric: false });
    case 4: {
      // array — element-wise, then by length
      const arrA = a as unknown[];
      const arrB = b as unknown[];
      const shared = Math.min(arrA.length, arrB.length);
      for (let i = 0; i < shared; i += 1) {
        const cmp = compareValues(arrA[i], arrB[i]);
        if (cmp !== 0) return cmp;
      }
      return arrA.length - arrB.length;
    }
    default: {
      // object — compare by sorted key/value pairs for determinism
      const objA = JSON.stringify(sortKeys(a as Record<string, unknown>));
      const objB = JSON.stringify(sortKeys(b as Record<string, unknown>));
      return objA < objB ? -1 : objA > objB ? 1 : 0;
    }
  }
}

function typeRank(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 2;
  if (typeof value === 'string') return 3;
  if (Array.isArray(value)) return 4;
  return 5;
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).sort(([x], [y]) => (x < y ? -1 : 1)));
}

export function matchesFilter(entity: unknown, filter: QueryFilter): boolean {
  const actual = readPath(entity, filter.field);
  const expected = filter.value;

  switch (filter.op) {
    case '==':
      return compareValues(actual, expected) === 0;
    case '!=':
      return compareValues(actual, expected) !== 0;
    case '<':
      return compareValues(actual, expected) < 0;
    case '<=':
      return compareValues(actual, expected) <= 0;
    case '>':
      return compareValues(actual, expected) > 0;
    case '>=':
      return compareValues(actual, expected) >= 0;
    case 'in':
      return asArray(expected).some((v) => compareValues(actual, v) === 0);
    case 'not-in':
      return !asArray(expected).some((v) => compareValues(actual, v) === 0);
    case 'array-contains':
      return Array.isArray(actual) && actual.some((v) => compareValues(v, expected) === 0);
    case 'array-contains-any':
      return (
        Array.isArray(actual) &&
        asArray(expected).some((needle) => actual.some((v) => compareValues(v, needle) === 0))
      );
    default:
      return assertNeverOperator(filter.op);
  }
}

export function matchesAllFilters(entity: unknown, filters: readonly QueryFilter[]): boolean {
  return filters.every((filter) => matchesFilter(entity, filter));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function assertNeverOperator(op: never): never {
  throw new ValidationError(`Unsupported filter operator '${String(op)}'`);
}

/**
 * Firestore caps `in` / `not-in` / `array-contains-any` at 30 disjuncts. The limit is
 * enforced in BOTH drivers so a query that works in development cannot fail in production.
 */
export const MAX_DISJUNCTION_SIZE = 30;

export function assertQueryIsPortable(filters: readonly QueryFilter[]): void {
  const disjunctive: FilterOperator[] = ['in', 'not-in', 'array-contains-any'];
  for (const filter of filters) {
    if (disjunctive.includes(filter.op)) {
      const size = asArray(filter.value).length;
      if (size === 0) {
        throw new ValidationError(`Filter '${filter.field} ${filter.op}' requires a non-empty list`, {
          field: filter.field,
        });
      }
      if (size > MAX_DISJUNCTION_SIZE) {
        throw new ValidationError(
          `Filter '${filter.field} ${filter.op}' exceeds the ${MAX_DISJUNCTION_SIZE}-value limit`,
          { field: filter.field, size, limit: MAX_DISJUNCTION_SIZE },
        );
      }
    }
  }

  const arrayContainsCount = filters.filter(
    (f) => f.op === 'array-contains' || f.op === 'array-contains-any',
  ).length;
  if (arrayContainsCount > 1) {
    throw new ValidationError('At most one array-contains filter is permitted per query');
  }
}

/** Comparator factory used by the in-memory driver and by cursor seeking. */
export function buildComparator<T>(
  orderBy: { field: string; direction: SortDirection }[],
): (a: T, b: T) => number {
  return (a, b) => {
    for (const { field, direction } of orderBy) {
      const cmp = compareValues(readPath(a, field), readPath(b, field));
      if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
    }
    return 0;
  };
}

/** True when `entity` sorts strictly after the cursor position. */
export function isAfterCursor<T>(
  entity: T,
  cursor: CursorPayload,
  orderBy: { field: string; direction: SortDirection }[],
): boolean {
  for (let i = 0; i < orderBy.length; i += 1) {
    const { field, direction } = orderBy[i]!;
    const cmp = compareValues(readPath(entity, field), cursor.values[i]);
    if (cmp !== 0) return direction === 'asc' ? cmp > 0 : cmp < 0;
  }
  return false; // Exactly equal on every key including id → this IS the cursor row.
}
