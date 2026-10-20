import { COLLECTION_ID_PREFIX, type CollectionName } from '@/constants/collections';
import { ErrorCode } from '@/constants/errorCodes';
import type {
  IRepository,
  PaginateOptions,
  ReadOptions,
  WriteOptions,
} from '@/interfaces/repository.port';
import type {
  AuditableEntity,
  CreateInput,
  Page,
  QueryFilter,
  QuerySpec,
  UpdateInput,
} from '@/types/common';
import { AlreadyExistsError, ConflictError, NotFoundError } from '@/utils/errors';
import { generateId } from '@/utils/ids';
import {
  assertQueryIsPortable,
  buildComparator,
  decodeCursor,
  encodeCursor,
  isAfterCursor,
  matchesAllFilters,
  readPath,
  sortFingerprint,
  withTotalOrdering,
} from '../query';
import type { MemoryDatastore, MemoryTransaction } from './memory.datastore';

/**
 * In-memory repository.
 *
 * Every value crossing this boundary is deep-cloned. Handing out a reference into the
 * backing map would let a caller mutate "persisted" state without a write — which works
 * fine in the memory driver and then fails mysteriously the day the deployment switches to
 * Firestore. Cloning makes the two drivers behave identically, which is the whole point of
 * having two.
 */
export class MemoryRepository<T extends AuditableEntity> implements IRepository<T> {
  constructor(
    readonly collection: CollectionName,
    private readonly datastore: MemoryDatastore,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  async findById(id: string, options: ReadOptions = {}): Promise<T | null> {
    const tx = this.datastore.unwrap(options.tx);
    tx?.assertReadAllowed(`${this.collection}.findById`);

    // Committed state only — a transaction never observes its own staged writes. See the
    // rationale on `MemoryTransaction`.
    const stored = this.datastore.raw(this.collection).get(id) ?? null;
    tx?.recordRead(this.collection, id, stored ? ((stored.version as number) ?? 0) : null);
    return stored ? (clone(stored) as T) : null;
  }

  async getById(id: string, options: ReadOptions = {}): Promise<T> {
    const found = await this.findById(id, options);
    if (!found) throw new NotFoundError(entityLabel(this.collection), id);
    return found;
  }

  async exists(id: string, options: ReadOptions = {}): Promise<boolean> {
    return (await this.findById(id, options)) !== null;
  }

  async findByIds(ids: string[], options: ReadOptions = {}): Promise<(T | null)[]> {
    return Promise.all(ids.map((id) => this.findById(id, options)));
  }

  async findMany(spec: QuerySpec = {}, options: ReadOptions = {}): Promise<T[]> {
    const filters = spec.filters ?? [];
    assertQueryIsPortable(filters);

    const orderBy = withTotalOrdering(spec.orderBy);
    const rows = this.snapshot(options)
      .filter((row) => matchesAllFilters(row, filters))
      .sort(buildComparator<T>(orderBy));

    const limited = spec.limit !== undefined ? rows.slice(0, spec.limit) : rows;
    return limited.map((row) => clone(row));
  }

  async findOne(filters: QueryFilter[], options: ReadOptions = {}): Promise<T | null> {
    const [first] = await this.findMany({ filters, limit: 1 }, options);
    return first ?? null;
  }

  async count(filters: QueryFilter[] = [], options: ReadOptions = {}): Promise<number> {
    assertQueryIsPortable(filters);
    return this.snapshot(options).filter((row) => matchesAllFilters(row, filters)).length;
  }

  async paginate(options: PaginateOptions): Promise<Page<T>> {
    const filters = options.filters ?? [];
    assertQueryIsPortable(filters);

    const orderBy = withTotalOrdering(options.orderBy);
    const sortKey = sortFingerprint(orderBy);

    const matched = this.snapshot(options)
      .filter((row) => matchesAllFilters(row, filters))
      .sort(buildComparator<T>(orderBy));

    let window = matched;
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor, sortKey);
      window = matched.filter((row) => isAfterCursor(row, cursor, orderBy));
    }

    // Fetch one extra row to determine whether a further page exists, without a count.
    const slice = window.slice(0, options.limit + 1);
    const hasMore = slice.length > options.limit;
    const items = slice.slice(0, options.limit).map((row) => clone(row));

    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            values: orderBy.map((o) => readPath(last, o.field)),
            id: last.id,
            sortKey,
          })
        : null;

    return {
      items,
      nextCursor,
      ...(options.includeTotal ? { total: matched.length } : {}),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Writes                                                              */
  /* ------------------------------------------------------------------ */

  async create(input: CreateInput<T>, options: WriteOptions = {}): Promise<T> {
    const tx = this.datastore.unwrap(options.tx);
    const id = input.id ?? generateId(COLLECTION_ID_PREFIX[this.collection]);

    if (!tx && this.datastore.raw(this.collection).has(id)) {
      // Checked synchronously against the backing map: an `await` between the existence
      // test and the write would open a window in which two concurrent creates both
      // observe "absent" and the second silently overwrites the first.
      throw new AlreadyExistsError(entityLabel(this.collection), 'id', id);
    }

    const now = new Date().toISOString();
    const entity = {
      ...(input as object),
      id,
      createdAt: now,
      updatedAt: now,
      version: 1,
      ...(options.actor ? { createdBy: options.actor.userId, updatedBy: options.actor.userId } : {}),
    } as T;

    if (tx) {
      // Write-only inside a transaction — no existence read, because that would violate
      // reads-before-writes. Duplicates are detected at commit, as Firestore does.
      tx.stageCreate(this.collection, id, entity as unknown as Record<string, unknown>);
    } else {
      this.write(id, entity as unknown as Record<string, unknown>, undefined);
    }
    return clone(entity);
  }

  async createMany(inputs: CreateInput<T>[], options: WriteOptions = {}): Promise<T[]> {
    const created: T[] = [];
    for (const input of inputs) {
      created.push(await this.create(input, options));
    }
    return created;
  }

  async update(id: string, patch: UpdateInput<T>, options: WriteOptions = {}): Promise<T> {
    const tx = this.datastore.unwrap(options.tx);
    const current = await this.findById(id, { tx: options.tx });
    if (!current) throw new NotFoundError(entityLabel(this.collection), id);

    assertVersionMatches(current, options.expectedVersion, this.collection, id);

    const next = mergePatch(current, patch, options);
    this.write(id, next as unknown as Record<string, unknown>, tx);
    return clone(next);
  }

  async applyUpdate(current: T, patch: UpdateInput<T>, options: WriteOptions = {}): Promise<T> {
    const tx = this.datastore.unwrap(options.tx);
    assertVersionMatches(current, options.expectedVersion, this.collection, current.id);

    const next = mergePatch(current, patch, options);
    this.write(current.id, next as unknown as Record<string, unknown>, tx);
    return clone(next);
  }

  async applyDelete(current: T, options: WriteOptions = {}): Promise<void> {
    const tx = this.datastore.unwrap(options.tx);
    assertVersionMatches(current, options.expectedVersion, this.collection, current.id);

    if (tx) {
      tx.stageDelete(this.collection, current.id);
    } else {
      this.datastore.raw(this.collection).delete(current.id);
      this.datastore.touch(this.collection);
    }
  }

  async upsert(id: string, input: CreateInput<T>, options: WriteOptions = {}): Promise<T> {
    const existing = await this.findById(id, { tx: options.tx });
    if (!existing) return this.create({ ...input, id }, options);
    return this.update(id, input as unknown as UpdateInput<T>, options);
  }

  async mutate(
    id: string,
    mutator: (current: T) => UpdateInput<T> | Promise<UpdateInput<T>>,
    options: WriteOptions = {},
  ): Promise<T> {
    // Inside an explicit transaction the datastore already guarantees isolation, so the
    // read-modify-write simply enlists. Outside one, we open a transaction so the mutator
    // gets the same atomicity guarantee either way.
    if (options.tx) {
      const current = await this.getById(id, { tx: options.tx });
      return this.update(id, await mutator(current), options);
    }

    return this.datastore.runTransaction(async (tx) => {
      const current = await this.getById(id, { tx });
      return this.update(id, await mutator(current), { ...options, tx });
    }, `mutate:${this.collection}:${id}`);
  }

  async delete(id: string, options: WriteOptions = {}): Promise<void> {
    const tx = this.datastore.unwrap(options.tx);
    const current = await this.findById(id, { tx: options.tx });
    if (!current) throw new NotFoundError(entityLabel(this.collection), id);

    assertVersionMatches(current, options.expectedVersion, this.collection, id);

    if (tx) {
      tx.stageDelete(this.collection, id);
    } else {
      this.datastore.raw(this.collection).delete(id);
      this.datastore.touch(this.collection);
    }
  }

  async deleteMany(filters: QueryFilter[], options: WriteOptions = {}): Promise<number> {
    const tx = this.datastore.unwrap(options.tx);
    const victims = await this.findMany({ filters }, { tx: options.tx });

    for (const victim of victims) {
      if (tx) {
        // Stage directly. Routing through `delete()` would re-read each document, and the
        // second iteration's read would land after the first iteration's write.
        tx.stageDelete(this.collection, victim.id);
      } else {
        this.datastore.raw(this.collection).delete(victim.id);
      }
    }

    if (!tx && victims.length > 0) this.datastore.touch(this.collection);
    return victims.length;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The visible set of rows for a read: committed documents only, never the caller's own
   * staged writes. Query reads are not individually version-tracked — Firestore likewise
   * cannot detect a document entering or leaving a query result set mid-transaction — so
   * conflict detection rests on the point reads a caller performs.
   */
  private snapshot(options: ReadOptions): T[] {
    const tx = this.datastore.unwrap(options.tx);
    tx?.assertReadAllowed(`${this.collection}.query`);
    return [...this.datastore.raw(this.collection).values()] as unknown as T[];
  }

  private write(id: string, value: Record<string, unknown>, tx: MemoryTransaction | undefined): void {
    if (tx) {
      tx.stageSet(this.collection, id, value);
    } else {
      this.datastore.raw(this.collection).set(id, value);
      this.datastore.touch(this.collection);
    }
  }
}

/**
 * `structuredClone` rather than `JSON.parse(JSON.stringify(...))`: the latter silently
 * converts `undefined` to absent, `Date` to string, and throws on cyclic input.
 */
function clone<V>(value: V): V {
  return structuredClone(value);
}

/** Merge a patch over an entity, preserving repository-owned identity and provenance. */
function mergePatch<T extends AuditableEntity>(
  current: T,
  patch: UpdateInput<T>,
  options: WriteOptions,
): T {
  return {
    ...current,
    ...(patch as object),
    // Identity and provenance fields are never patchable.
    id: current.id,
    createdAt: current.createdAt,
    createdBy: current.createdBy,
    updatedAt: new Date().toISOString(),
    version: current.version + 1,
    ...(options.actor ? { updatedBy: options.actor.userId } : {}),
  } as T;
}

function assertVersionMatches(
  current: AuditableEntity,
  expectedVersion: number | undefined,
  collection: CollectionName,
  id: string,
): void {
  if (expectedVersion === undefined || current.version === expectedVersion) return;
  throw new ConflictError(
    `${entityLabel(collection)} '${id}' was modified by another operation; reload and retry`,
    ErrorCode.CONCURRENT_MODIFICATION,
    { collection, id, expectedVersion, actualVersion: current.version },
  );
}

/** `contentionEvents` → `Contention event`, for readable error messages. */
function entityLabel(collection: CollectionName): string {
  const words = collection.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
  const singular = words.endsWith('ies')
    ? `${words.slice(0, -3)}y`
    : words.endsWith('s')
      ? words.slice(0, -1)
      : words;
  return singular.charAt(0).toUpperCase() + singular.slice(1);
}
