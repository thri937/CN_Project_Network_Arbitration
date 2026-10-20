import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Identifier generation.
 *
 * Domain entities use human-legible prefixed identifiers (`SLC-…`, `ARB-…`) rather than
 * bare UUIDs. In an auditable system, operators read these ids aloud in incident calls and
 * paste them into tickets; a prefix that says what the thing is has real operational value.
 *
 * The random component is monotonic-prefixed (base36 timestamp) so that lexicographic
 * ordering of ids approximates chronological ordering — useful for Firestore range queries
 * and for stable pagination without a secondary index.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U.

function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // Non-null assertion is safe: `i < length` and `bytes.length === length`.
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

function timeComponent(at: number): string {
  return at.toString(36).toUpperCase().padStart(9, '0');
}

export const IdPrefix = {
  USER: 'USR',
  DEPARTMENT: 'DEP',
  POLICY: 'POL',
  SLICE: 'SLC',
  TELEMETRY: 'TLM',
  CAPACITY: 'CAP',
  CONTENTION: 'CTN',
  ARBITRATION: 'ARB',
  AUDIT: 'AUD',
  NOTIFICATION: 'NTF',
  ALLOCATION: 'ALC',
} as const;
export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

/**
 * @param prefix  entity-kind prefix, e.g. `IdPrefix.ARBITRATION`
 * @param at      timestamp in epoch ms; injectable for deterministic tests
 */
export function generateId(prefix: IdPrefix, at: number = Date.now()): string {
  return `${prefix}-${timeComponent(at)}-${randomBase32(6)}`;
}

/** Opaque correlation id for tracing one request across services and log lines. */
export function generateCorrelationId(): string {
  return randomUUID();
}

const ID_PATTERN = /^[A-Z]{3}-[0-9A-Z]{9,}-[0-9A-HJKMNP-TV-Z]{6}$/;

export function isGeneratedId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/**
 * Extract the epoch-ms creation time encoded in a generated id, or null if the value is
 * not one of our identifiers.
 *
 * The full-pattern check is not redundant with the parse: base36 accepts almost any
 * alphanumeric run, so a foreign string such as `not-an-id` would otherwise decode to a
 * plausible-looking number (383) and be silently treated as a 1970 timestamp.
 */
export function timestampFromId(id: string): number | null {
  if (!isGeneratedId(id)) return null;
  const decoded = Number.parseInt(id.split('-')[1]!, 36);
  return Number.isFinite(decoded) ? decoded : null;
}
