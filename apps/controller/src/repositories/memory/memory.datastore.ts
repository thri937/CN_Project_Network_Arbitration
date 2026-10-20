import { ALL_COLLECTIONS, type CollectionName } from '@/constants/collections';
import { env } from '@/config/env';
import type {
  IDatastore,
  IRepository,
  TransactionContext,
} from '@/interfaces/repository.port';
import type { AuditableEntity } from '@/types/common';
import { AlreadyExistsError, ConflictError, InternalError } from '@/utils/errors';
import { ErrorCode } from '@/constants/errorCodes';
import { createLogger } from '@/utils/logger';
import { SnapshotPersistence } from './persistence';
import { MemoryRepository } from './memory.repository';

const log = createLogger('memory-datastore');

export const MEMORY_DRIVER = 'memory';

/** A single staged mutation inside an open transaction. */
type StagedWrite =
  | { op: 'create'; collection: CollectionName; id: string; value: Record<string, unknown> }
  | { op: 'set'; collection: CollectionName; id: string; value: Record<string, unknown> }
  | { op: 'delete'; collection: CollectionName; id: string };

/**
 * Transaction state.
 *
 * DELIBERATELY MIRRORS FIRESTORE'S RESTRICTIONS — INCLUDING THE INCONVENIENT ONES.
 * =============================================================================
 * An earlier version of this class supported read-your-writes: a read inside the
 * transaction could observe the transaction's own staged mutations. That is a *stronger*
 * guarantee than Firestore provides, and the repository contract suite caught the
 * consequence immediately — the same code passed on `memory` and failed on Firestore.
 *
 * A development driver that is more permissive than the production driver is worse than no
 * development driver at all: it lets a developer write code that cannot work in
 * production, and defers the discovery to deployment. So this implementation adopts the
 * INTERSECTION of both drivers' guarantees:
 *
 *   1. All reads must precede all writes. A read issued after a write throws, with the
 *      same meaning as Firestore's "Firestore transactions require all reads to be
 *      executed before all writes".
 *   2. Reads observe the committed snapshot only — never the transaction's staged writes.
 *   3. Reads record the observed `version`; a change before commit aborts and re-runs the
 *      callback (Firestore's optimistic retry, reproduced).
 *
 * Practical consequence for callers: gather everything you need to read first, compute,
 * then write. Module 9's allocation manager is structured exactly that way.
 */
export class MemoryTransaction {
  readonly reads = new Map<string, number | null>();
  readonly writes = new Map<string, StagedWrite>();
  private writesStarted = false;

  static key(collection: CollectionName, id: string): string {
    return `${collection}:${id}`;
  }

  /** Enforces the reads-before-writes ordering rule. */
  assertReadAllowed(operation: string): void {
    if (!this.writesStarted) return;
    throw new ConflictError(
      `Transactions require all reads to be executed before all writes; ` +
        `'${operation}' was attempted after a write. Read everything you need first, ` +
        `then compute, then write.`,
      ErrorCode.INVALID_STATE_TRANSITION,
      { operation },
    );
  }

  recordRead(collection: CollectionName, id: string, version: number | null): void {
    const key = MemoryTransaction.key(collection, id);
    // Keep the FIRST observed version: that is the value the callback made decisions on.
    if (!this.reads.has(key)) this.reads.set(key, version);
  }

  /** Fails at commit if the document already exists — mirrors Firestore `tx.create()`. */
  stageCreate(collection: CollectionName, id: string, value: Record<string, unknown>): void {
    const key = MemoryTransaction.key(collection, id);
    if (this.writes.has(key)) {
      throw new AlreadyExistsError('Document', 'id', id);
    }
    this.writesStarted = true;
    this.writes.set(key, { op: 'create', collection, id, value });
  }

  stageSet(collection: CollectionName, id: string, value: Record<string, unknown>): void {
    this.writesStarted = true;
    this.writes.set(MemoryTransaction.key(collection, id), { op: 'set', collection, id, value });
  }

  stageDelete(collection: CollectionName, id: string): void {
    this.writesStarted = true;
    this.writes.set(MemoryTransaction.key(collection, id), { op: 'delete', collection, id });
  }
}

export interface MemoryDatastoreOptions {
  directory?: string;
  persist?: boolean;
  flushMs?: number;
}

/**
 * In-memory datastore adapter.
 *
 * NOT a mock. It implements the complete `IDatastore` contract — cursor pagination,
 * optimistic locking, transactions with snapshot-conflict retry — and persists to disk. It
 * exists so the platform is fully runnable and CI-testable without a cloud project, and so
 * the repository contract suite can prove the two drivers are interchangeable.
 *
 * Rejected at boot when `NODE_ENV=production` (see `config/env.ts`).
 */
export class MemoryDatastore implements IDatastore {
  readonly driver = MEMORY_DRIVER;

  private readonly collections = new Map<CollectionName, Map<string, Record<string, unknown>>>();
  private readonly repositories = new Map<CollectionName, IRepository<never>>();
  private readonly persistence: SnapshotPersistence;

  /** Serialises transactions against each other so only tx-vs-non-tx races need retry. */
  private commitQueue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  private static readonly MAX_TRANSACTION_ATTEMPTS = 5;

  constructor(options: MemoryDatastoreOptions = {}) {
    for (const name of ALL_COLLECTIONS) {
      this.collections.set(name, new Map());
    }

    this.persistence = new SnapshotPersistence(
      {
        directory: options.directory ?? env.MEMORY_STORE_DIR,
        enabled: options.persist ?? env.MEMORY_STORE_PERSIST,
        flushMs: options.flushMs ?? env.MEMORY_STORE_FLUSH_MS,
      },
      (name) => Object.fromEntries(this.raw(name)),
    );
  }

  /** Must be awaited before first use; rehydrates persisted snapshots. */
  async initialise(): Promise<void> {
    if (this.loaded) return;
    const snapshots = await this.persistence.load(ALL_COLLECTIONS);
    for (const [name, documents] of snapshots) {
      const target = this.raw(name);
      for (const [id, value] of Object.entries(documents)) {
        target.set(id, value as Record<string, unknown>);
      }
    }
    this.loaded = true;
    log.info(
      { documents: [...this.collections.values()].reduce((n, c) => n + c.size, 0) },
      'in-memory datastore ready',
    );
  }

  repository<T extends AuditableEntity>(collection: CollectionName): IRepository<T> {
    let existing = this.repositories.get(collection);
    if (!existing) {
      existing = new MemoryRepository<T>(collection, this) as unknown as IRepository<never>;
      this.repositories.set(collection, existing);
    }
    return existing as unknown as IRepository<T>;
  }

  async runTransaction<R>(
    fn: (tx: TransactionContext) => Promise<R>,
    label = 'transaction',
  ): Promise<R> {
    // Chain onto the queue so transactions never interleave with one another. Each link
    // swallows the previous result so one failure cannot poison the queue for everyone.
    const run = this.commitQueue.then(
      () => this.attemptTransaction(fn, label),
      () => this.attemptTransaction(fn, label),
    );
    this.commitQueue = run.catch(() => undefined);
    return run;
  }

  private async attemptTransaction<R>(
    fn: (tx: TransactionContext) => Promise<R>,
    label: string,
  ): Promise<R> {
    for (let attempt = 1; attempt <= MemoryDatastore.MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const transaction = new MemoryTransaction();
      const context: TransactionContext = { driver: this.driver, native: transaction };

      const result = await fn(context);

      // Validate every read against the live store before applying any write.
      const conflict = this.findConflict(transaction);
      if (!conflict) {
        this.assertStagedCreatesAreNovel(transaction);
        this.commit(transaction);
        return result;
      }

      log.warn(
        { label, attempt, conflict },
        'transaction observed a concurrent modification; retrying',
      );
    }

    throw new ConflictError(
      `Transaction '${label}' could not commit after ${MemoryDatastore.MAX_TRANSACTION_ATTEMPTS} attempts due to concurrent modification`,
      ErrorCode.CONCURRENT_MODIFICATION,
      { label },
    );
  }

  private findConflict(transaction: MemoryTransaction): string | null {
    for (const [key, observedVersion] of transaction.reads) {
      const separator = key.indexOf(':');
      const collection = key.slice(0, separator) as CollectionName;
      const id = key.slice(separator + 1);
      const current = this.raw(collection).get(id);
      const currentVersion = current ? ((current.version as number) ?? 0) : null;
      if (currentVersion !== observedVersion) return key;
    }
    return null;
  }

  /**
   * A staged `create` is only checked at commit — exactly as Firestore's `tx.create()`
   * behaves. Checking it eagerly would require a read, which the reads-before-writes rule
   * forbids at that point in the callback.
   */
  private assertStagedCreatesAreNovel(transaction: MemoryTransaction): void {
    for (const write of transaction.writes.values()) {
      if (write.op !== 'create') continue;
      if (this.raw(write.collection).has(write.id)) {
        throw new AlreadyExistsError(write.collection, 'id', write.id);
      }
    }
  }

  private commit(transaction: MemoryTransaction): void {
    const touched = new Set<CollectionName>();
    for (const write of transaction.writes.values()) {
      const target = this.raw(write.collection);
      if (write.op === 'delete') target.delete(write.id);
      else target.set(write.id, write.value);
      touched.add(write.collection);
    }
    for (const name of touched) this.persistence.markDirty(name);
  }

  /* ---- Internal access used by MemoryRepository ------------------------ */

  /** @internal Direct access to a collection's backing map. */
  raw(collection: CollectionName): Map<string, Record<string, unknown>> {
    const existing = this.collections.get(collection);
    if (!existing) {
      // Unknown collection means a typo that would otherwise silently read as empty.
      throw new InternalError(`Unknown collection '${collection}'`);
    }
    return existing;
  }

  /** @internal Signals that a collection changed outside a transaction. */
  touch(collection: CollectionName): void {
    this.persistence.markDirty(collection);
  }

  /** @internal Unwraps and validates a transaction handle produced by THIS driver. */
  unwrap(tx: TransactionContext | undefined): MemoryTransaction | undefined {
    if (!tx) return undefined;
    if (tx.driver !== this.driver || !(tx.native instanceof MemoryTransaction)) {
      // Silently ignoring a foreign handle would turn an atomic operation into a set of
      // independent writes — exactly the failure the transaction was there to prevent.
      throw new InternalError(
        `Transaction from driver '${tx.driver}' cannot be used with the '${this.driver}' datastore`,
      );
    }
    return tx.native;
  }

  async ping(): Promise<void> {
    if (!this.loaded) throw new InternalError('In-memory datastore has not been initialised');
  }

  async dispose(): Promise<void> {
    await this.persistence.dispose();
    log.info('in-memory datastore disposed');
  }

  /** Test-only: wipe every collection. Guarded so it can never run in production. */
  async reset(): Promise<void> {
    if (env.isProduction) throw new InternalError('reset() is not permitted in production');
    for (const collection of this.collections.values()) collection.clear();
    for (const name of ALL_COLLECTIONS) this.persistence.markDirty(name);
  }
}
