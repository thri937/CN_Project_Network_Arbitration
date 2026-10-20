import { IdPrefix } from '@/utils/ids';

/**
 * Canonical datastore collection names.
 *
 * Centralised so that the Firestore adapter, the in-memory adapter, the security-rules
 * file and the seed script cannot drift apart. Never inline a collection name string.
 */
export const Collections = {
  USERS: 'users',
  DEPARTMENTS: 'departments',
  POLICIES: 'policies',
  SLICES: 'slices',
  TELEMETRY: 'telemetry',
  CAPACITY: 'capacity',
  CONTENTION_EVENTS: 'contentionEvents',
  ARBITRATION_HISTORY: 'arbitrationHistory',
  AUDIT_LOGS: 'auditLogs',
  NOTIFICATIONS: 'notifications',
  SETTINGS: 'settings',
} as const;

export type CollectionName = (typeof Collections)[keyof typeof Collections];

export const ALL_COLLECTIONS: readonly CollectionName[] = Object.freeze(
  Object.values(Collections),
);

/**
 * Collections that grow without bound from the telemetry pipeline and are subject to
 * retention pruning by `jobs/retention.job.ts`.
 */
export const HIGH_VOLUME_COLLECTIONS: readonly CollectionName[] = Object.freeze([
  Collections.TELEMETRY,
  Collections.CAPACITY,
  Collections.NOTIFICATIONS,
]);

/** The singleton document id used inside the `settings` collection. */
export const SETTINGS_DOCUMENT_ID = 'global';

/**
 * Identifier prefix per collection, so a repository can mint a correctly-typed id when the
 * caller does not supply one. Keeping the mapping here (rather than inside each service)
 * guarantees that an `auditLogs` document can never end up with a `SLC-` id.
 */
export const COLLECTION_ID_PREFIX: Readonly<Record<CollectionName, IdPrefix>> = Object.freeze({
  [Collections.USERS]: IdPrefix.USER,
  [Collections.DEPARTMENTS]: IdPrefix.DEPARTMENT,
  [Collections.POLICIES]: IdPrefix.POLICY,
  [Collections.SLICES]: IdPrefix.SLICE,
  [Collections.TELEMETRY]: IdPrefix.TELEMETRY,
  [Collections.CAPACITY]: IdPrefix.CAPACITY,
  [Collections.CONTENTION_EVENTS]: IdPrefix.CONTENTION,
  [Collections.ARBITRATION_HISTORY]: IdPrefix.ARBITRATION,
  [Collections.AUDIT_LOGS]: IdPrefix.AUDIT,
  [Collections.NOTIFICATIONS]: IdPrefix.NOTIFICATION,
  [Collections.SETTINGS]: IdPrefix.POLICY,
});
