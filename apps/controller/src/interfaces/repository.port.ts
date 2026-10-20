import type { CollectionName } from '@/constants/collections';
import type {
  ActorContext,
  AuditableEntity,
  CreateInput,
  Page,
  QueryFilter,
  QuerySpec,
  SortDirection,
  UpdateInput,
} from '@/types/common';

/**
 * PORT — Persistence
 *
 * The application layer depends on these interfaces and never on `firebase-admin`, a
 * Firestore `Query`, or an in-memory `Map`. Swapping `DATASTORE_DRIVER` re-binds the
 * implementation in the composition root and nothing above changes.
 *
 * A single generic `IRepository<T>` covers the entire CRUD/query surface. Entity-specific
 * queries live in thin typed wrappers that compose it, so pagination, optimistic locking
 * and audit-field stamping have exactly ONE implementation per driver rather than eleven
 * near-identical copies.
 */

/**
 * Opaque handle to an in-flight transaction. The concrete payload is driver-specific and
 * must never be inspected outside the adapter that produced it — `driver` exists purely so
 * an adapter can fail loudly if a foreign transaction is passed to it, rather than
 * silently performing a non-transactional write.
 */
export interface TransactionContext {
  readonly driver: string;
  readonly native: unknown;
}

export interface ReadOptions {
  tx?: TransactionContext | undefined;
}

export interface WriteOptions extends ReadOptions {
  /** Stamped into `createdBy` / `updatedBy`. */
  actor?: ActorContext | undefined;
  /**
   * Optimistic concurrency guard. When supplied, the write fails with
   * CONCURRENT_MODIFICATION unless the stored `version` matches exactly.
   */
  expectedVersion?: number | undefined;
}

export interface PaginateOptions extends ReadOptions {
  limit: number;
  cursor?: string | undefined;
  filters?: QueryFilter[] | undefined;
  orderBy?: { field: string; direction: SortDirection }[] | undefined;
  /** Counting requires a full scan; opt in explicitly and only for small collections. */
  includeTotal?: boolean | undefined;
}

export interface IRepository<T extends AuditableEntity> {
  readonly collection: CollectionName;

  /* ---- Reads ---------------------------------------------------------- */

  findById(id: string, options?: ReadOptions): Promise<T | null>;

  /** As `findById`, but throws `NotFoundError` instead of returning null. */
  getById(id: string, options?: ReadOptions): Promise<T>;

  findMany(spec?: QuerySpec, options?: ReadOptions): Promise<T[]>;

  findOne(filters: QueryFilter[], options?: ReadOptions): Promise<T | null>;

  /**
   * Cursor-paginated read. `id` is always appended as the final sort key so the ordering
   * is total and the cursor is unambiguous even when the primary sort field has ties.
   */
  paginate(options: PaginateOptions): Promise<Page<T>>;

  count(filters?: QueryFilter[], options?: ReadOptions): Promise<number>;

  exists(id: string, options?: ReadOptions): Promise<boolean>;

  /** Batched multi-get. Order of the result matches the order of `ids`; misses are null. */
  findByIds(ids: string[], options?: ReadOptions): Promise<(T | null)[]>;

  /* ---- Writes --------------------------------------------------------- */

  /**
   * @throws {AlreadyExistsError} when `input.id` is supplied and already present.
   */
  create(input: CreateInput<T>, options?: WriteOptions): Promise<T>;

  createMany(inputs: CreateInput<T>[], options?: WriteOptions): Promise<T[]>;

  /**
   * Partial update. Increments `version` and refreshes `updatedAt`/`updatedBy`.
   * @throws {NotFoundError} when the document does not exist.
   * @throws {ConflictError} when `expectedVersion` does not match.
   */
  update(id: string, patch: UpdateInput<T>, options?: WriteOptions): Promise<T>;

  /**
   * WRITE-ONLY update, for a caller that has ALREADY loaded the entity.
   *
   * `update()` is read-modify-write, so inside a transaction it can only ever be the first
   * write — the reads-before-writes rule forbids the read it performs from happening after
   * any earlier write. A service that must mutate several documents atomically therefore
   * cannot use it more than once.
   *
   * This method closes that gap. The caller reads everything it needs up front, computes,
   * then issues write-only patches:
   *
   *     const [a, b] = await Promise.all([repo.getById(x, { tx }), repo.getById(y, { tx })]);
   *     await repo.applyUpdate(a, { status: 'ARCHIVED' }, { tx });
   *     await repo.applyUpdate(b, { status: 'ACTIVE' },   { tx });
   *
   * Optimistic concurrency is still enforced: `current.version` was observed inside the
   * transaction, so a concurrent change to it aborts the whole transaction at commit.
   */
  applyUpdate(current: T, patch: UpdateInput<T>, options?: WriteOptions): Promise<T>;

  /** WRITE-ONLY delete, for a caller that has already loaded the entity. See `applyUpdate`. */
  applyDelete(current: T, options?: WriteOptions): Promise<void>;

  /** Create if absent, patch if present. Used by singleton documents such as settings. */
  upsert(id: string, input: CreateInput<T>, options?: WriteOptions): Promise<T>;

  delete(id: string, options?: WriteOptions): Promise<void>;

  /** @returns number of documents removed. */
  deleteMany(filters: QueryFilter[], options?: WriteOptions): Promise<number>;

  /**
   * Read-modify-write under the driver's concurrency guarantees. The mutator receives the
   * current entity and returns a patch; it MAY be invoked more than once if the driver
   * retries on contention, so it must be free of side effects.
   */
  mutate(
    id: string,
    mutator: (current: T) => UpdateInput<T> | Promise<UpdateInput<T>>,
    options?: WriteOptions,
  ): Promise<T>;
}

/**
 * PORT — Datastore
 *
 * Owns connection lifecycle, repository construction and transactions.
 */
export interface IDatastore {
  readonly driver: string;

  repository<T extends AuditableEntity>(collection: CollectionName): IRepository<T>;

  /**
   * Runs `fn` atomically. The callback receives a `TransactionContext` to thread through
   * repository calls. Either every enlisted write commits or none does.
   *
   * TRANSACTION CONTRACT — binding on every implementation:
   *
   *  1. **All reads must precede all writes.** A read issued after any write throws. This
   *     is a hard Firestore restriction; the in-memory driver enforces it identically so
   *     that a violation surfaces in development rather than in production.
   *
   *  2. **Reads observe the committed snapshot, never the transaction's own staged
   *     writes.** There is no read-your-writes.
   *
   *  3. **The callback MUST be free of side effects outside the transaction**, because it
   *     may be executed more than once: Firestore retries on write contention, and the
   *     in-memory driver retries after a snapshot conflict.
   *
   * The practical shape of a compliant callback is: read everything → compute → write
   * everything. `services/allocation.service.ts` is written exactly that way.
   */
  runTransaction<R>(fn: (tx: TransactionContext) => Promise<R>, label?: string): Promise<R>;

  /** Connectivity probe for the health registry. */
  ping(): Promise<void>;

  /** Flush buffers and release connections. Called during graceful shutdown. */
  dispose(): Promise<void>;
}
