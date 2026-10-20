import {
  FieldValue,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type Query,
  type Transaction,
} from 'firebase-admin/firestore';
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
import { AlreadyExistsError, ConflictError, DatastoreError, NotFoundError } from '@/utils/errors';
import { generateId } from '@/utils/ids';
import {
  assertQueryIsPortable,
  decodeCursor,
  encodeCursor,
  readPath,
  sortFingerprint,
  withTotalOrdering,
} from '../query';
import type { FirestoreDatastore } from './firestore.datastore';

/** gRPC status code 6 = ALREADY_EXISTS, 5 = NOT_FOUND. */
const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;

/**
 * Firestore repository — production persistence.
 *
 * Notes on the mapping to Firestore semantics:
 *
 *  - The document id is ALSO stored as an `id` field. Firestore can order by
 *    `FieldPath.documentId()`, but that path cannot be mixed freely with cursors built
 *    from field values. Duplicating the id as a field keeps the sort specification, the
 *    cursor encoding and the comparator identical to the in-memory driver, at the cost of
 *    a few bytes per document.
 *
 *  - `update()` writes through `DocumentReference.update()` rather than `set(…, {merge})`
 *    because `update()` fails on a missing document. `set` with merge would silently
 *    resurrect a deleted entity — a genuinely dangerous behaviour for slices, where a
 *    ghost record would keep consuming capacity in the arbitration snapshot.
 *
 *  - Batched deletes are chunked at 450, below Firestore's 500-operation batch limit, to
 *    leave headroom for the SDK's own bookkeeping.
 */
export class FirestoreRepository<T extends AuditableEntity> implements IRepository<T> {
  private readonly ref: CollectionReference<DocumentData>;

  private static readonly MAX_BATCH_SIZE = 450;
  /** Firestore's `getAll` / `in` limits; we chunk multi-gets to stay within them. */
  private static readonly MAX_MULTI_GET = 300;

  constructor(
    readonly collection: CollectionName,
    private readonly firestore: Firestore,
    private readonly datastore: FirestoreDatastore,
  ) {
    this.ref = firestore.collection(collection);
  }

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  async findById(id: string, options: ReadOptions = {}): Promise<T | null> {
    const tx = this.datastore.unwrap(options.tx);
    return this.guard('findById', async () => {
      const doc = tx ? await tx.get(this.doc(id)) : await this.doc(id).get();
      return doc.exists ? this.fromDocument(doc.id, doc.data()) : null;
    });
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
    if (ids.length === 0) return [];
    const tx = this.datastore.unwrap(options.tx);

    return this.guard('findByIds', async () => {
      const found = new Map<string, T>();

      for (const chunk of chunked(dedupe(ids), FirestoreRepository.MAX_MULTI_GET)) {
        const refs = chunk.map((id) => this.doc(id));
        const docs = tx ? await tx.getAll(...refs) : await this.firestore.getAll(...refs);
        for (const doc of docs) {
          if (doc.exists) found.set(doc.id, this.fromDocument(doc.id, doc.data()));
        }
      }

      // Preserve the caller's ordering, including duplicates, with null for misses.
      return ids.map((id) => found.get(id) ?? null);
    });
  }

  async findMany(spec: QuerySpec = {}, options: ReadOptions = {}): Promise<T[]> {
    const filters = spec.filters ?? [];
    assertQueryIsPortable(filters);
    const tx = this.datastore.unwrap(options.tx);

    return this.guard('findMany', async () => {
      let query = this.applyFilters(this.ref, filters);
      for (const { field, direction } of withTotalOrdering(spec.orderBy)) {
        query = query.orderBy(field, direction);
      }
      if (spec.limit !== undefined) query = query.limit(spec.limit);

      const snapshot = tx ? await tx.get(query) : await query.get();
      return snapshot.docs.map((doc) => this.fromDocument(doc.id, doc.data()));
    });
  }

  async findOne(filters: QueryFilter[], options: ReadOptions = {}): Promise<T | null> {
    const [first] = await this.findMany({ filters, limit: 1 }, options);
    return first ?? null;
  }

  async count(filters: QueryFilter[] = [], options: ReadOptions = {}): Promise<number> {
    assertQueryIsPortable(filters);
    const tx = this.datastore.unwrap(options.tx);

    return this.guard('count', async () => {
      // Server-side aggregation: billed as one read per 1000 index entries rather than one
      // per document, which is the difference between a viable dashboard counter and an
      // expensive one.
      const aggregate = this.applyFilters(this.ref, filters).count();
      const snapshot = tx ? await tx.get(aggregate) : await aggregate.get();
      return snapshot.data().count;
    });
  }

  async paginate(options: PaginateOptions): Promise<Page<T>> {
    const filters = options.filters ?? [];
    assertQueryIsPortable(filters);

    const orderBy = withTotalOrdering(options.orderBy);
    const sortKey = sortFingerprint(orderBy);
    const tx = this.datastore.unwrap(options.tx);

    return this.guard('paginate', async () => {
      let query = this.applyFilters(this.ref, filters);
      for (const { field, direction } of orderBy) {
        query = query.orderBy(field, direction);
      }

      if (options.cursor) {
        const cursor = decodeCursor(options.cursor, sortKey);
        query = query.startAfter(...cursor.values);
      }

      // Over-fetch by one to detect a further page without a second query.
      query = query.limit(options.limit + 1);

      const snapshot = tx ? await tx.get(query) : await query.get();
      const rows = snapshot.docs.map((doc) => this.fromDocument(doc.id, doc.data()));

      const hasMore = rows.length > options.limit;
      const items = rows.slice(0, options.limit);
      const last = items[items.length - 1];

      const nextCursor =
        hasMore && last
          ? encodeCursor({
              values: orderBy.map((o) => readPath(last, o.field)),
              id: last.id,
              sortKey,
            })
          : null;

      const total = options.includeTotal ? await this.count(filters, options) : undefined;

      return { items, nextCursor, ...(total !== undefined ? { total } : {}) };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Writes                                                              */
  /* ------------------------------------------------------------------ */

  async create(input: CreateInput<T>, options: WriteOptions = {}): Promise<T> {
    const tx = this.datastore.unwrap(options.tx);
    const id = input.id ?? generateId(COLLECTION_ID_PREFIX[this.collection]);
    const now = new Date().toISOString();

    const entity = {
      ...(input as object),
      id,
      createdAt: now,
      updatedAt: now,
      version: 1,
      ...(options.actor ? { createdBy: options.actor.userId, updatedBy: options.actor.userId } : {}),
    } as T;

    const { id: _omit, ...payload } = entity as unknown as Record<string, unknown> & { id: string };

    return this.guard('create', async () => {
      try {
        // `create()` (not `set()`) so a duplicate id is rejected by the server rather than
        // silently overwriting an existing document.
        if (tx) tx.create(this.doc(id), { ...payload, id });
        else await this.doc(id).create({ ...payload, id });
      } catch (error) {
        if (grpcCode(error) === GRPC_ALREADY_EXISTS) {
          throw new AlreadyExistsError(entityLabel(this.collection), 'id', id);
        }
        throw error;
      }
      return entity;
    });
  }

  async createMany(inputs: CreateInput<T>[], options: WriteOptions = {}): Promise<T[]> {
    if (inputs.length === 0) return [];

    // Inside a caller-supplied transaction we must enlist in it, not open batches.
    if (options.tx) {
      const created: T[] = [];
      for (const input of inputs) created.push(await this.create(input, options));
      return created;
    }

    const now = new Date().toISOString();
    const entities = inputs.map(
      (input) =>
        ({
          ...(input as object),
          id: input.id ?? generateId(COLLECTION_ID_PREFIX[this.collection]),
          createdAt: now,
          updatedAt: now,
          version: 1,
          ...(options.actor
            ? { createdBy: options.actor.userId, updatedBy: options.actor.userId }
            : {}),
        }) as T,
    );

    return this.guard('createMany', async () => {
      for (const chunk of chunked(entities, FirestoreRepository.MAX_BATCH_SIZE)) {
        const batch = this.firestore.batch();
        for (const entity of chunk) {
          batch.create(this.doc(entity.id), entity as unknown as DocumentData);
        }
        await batch.commit();
      }
      return entities;
    });
  }

  async update(id: string, patch: UpdateInput<T>, options: WriteOptions = {}): Promise<T> {
    const tx = this.datastore.unwrap(options.tx);

    // Enlisted in a caller's transaction: read-check-write inside it.
    if (tx) {
      const current = await this.getById(id, options);
      assertVersionMatches(current, options.expectedVersion, this.collection, id);
      const next = this.mergePatch(current, patch, options);
      tx.set(this.doc(id), next as unknown as DocumentData);
      return next;
    }

    // A version guard is only meaningful if the check and the write are atomic.
    if (options.expectedVersion !== undefined) {
      return this.datastore.runTransaction(
        (ownTx) => this.update(id, patch, { ...options, tx: ownTx }),
        `update:${this.collection}:${id}`,
      );
    }

    // Unguarded update: a single server-side atomic increment, no read-before-write.
    const sanitised = stripImmutable(patch);
    const writePayload: DocumentData = {
      ...sanitised,
      updatedAt: new Date().toISOString(),
      version: FieldValue.increment(1),
      ...(options.actor ? { updatedBy: options.actor.userId } : {}),
    };

    return this.guard('update', async () => {
      try {
        await this.doc(id).update(writePayload);
      } catch (error) {
        if (grpcCode(error) === GRPC_NOT_FOUND) {
          throw new NotFoundError(entityLabel(this.collection), id);
        }
        throw error;
      }
      return this.getById(id);
    });
  }

  async applyUpdate(current: T, patch: UpdateInput<T>, options: WriteOptions = {}): Promise<T> {
    const tx = this.datastore.unwrap(options.tx);
    assertVersionMatches(current, options.expectedVersion, this.collection, current.id);

    const next = this.mergePatch(current, patch, options);

    return this.guard('applyUpdate', async () => {
      // `set` (full document) rather than `update` (field paths): the merged entity is
      // already complete, and `set` performs no read, which is the entire point.
      if (tx) tx.set(this.doc(current.id), next as unknown as DocumentData);
      else await this.doc(current.id).set(next as unknown as DocumentData);
      return next;
    });
  }

  async applyDelete(current: T, options: WriteOptions = {}): Promise<void> {
    const tx = this.datastore.unwrap(options.tx);
    assertVersionMatches(current, options.expectedVersion, this.collection, current.id);

    await this.guard('applyDelete', async () => {
      if (tx) tx.delete(this.doc(current.id));
      else await this.doc(current.id).delete();
    });
  }

  async upsert(id: string, input: CreateInput<T>, options: WriteOptions = {}): Promise<T> {
    const existing = await this.findById(id, options);
    if (!existing) return this.create({ ...input, id }, options);
    return this.update(id, input as unknown as UpdateInput<T>, options);
  }

  async mutate(
    id: string,
    mutator: (current: T) => UpdateInput<T> | Promise<UpdateInput<T>>,
    options: WriteOptions = {},
  ): Promise<T> {
    if (options.tx) {
      const current = await this.getById(id, options);
      return this.update(id, await mutator(current), options);
    }

    return this.datastore.runTransaction(async (tx) => {
      const current = await this.getById(id, { tx });
      return this.update(id, await mutator(current), { ...options, tx });
    }, `mutate:${this.collection}:${id}`);
  }

  async delete(id: string, options: WriteOptions = {}): Promise<void> {
    const tx = this.datastore.unwrap(options.tx);

    if (tx) {
      const current = await this.getById(id, options);
      assertVersionMatches(current, options.expectedVersion, this.collection, id);
      tx.delete(this.doc(id));
      return;
    }

    if (options.expectedVersion !== undefined) {
      await this.datastore.runTransaction(
        (ownTx) => this.delete(id, { ...options, tx: ownTx }),
        `delete:${this.collection}:${id}`,
      );
      return;
    }

    await this.guard('delete', async () => {
      // Firestore deletes are idempotent and succeed on a missing document. The port
      // contract says otherwise, so the existence check is explicit — callers rely on
      // NotFoundError to distinguish "already gone" from "never existed".
      const doc = await this.doc(id).get();
      if (!doc.exists) throw new NotFoundError(entityLabel(this.collection), id);
      await this.doc(id).delete();
    });
  }

  async deleteMany(filters: QueryFilter[], options: WriteOptions = {}): Promise<number> {
    assertQueryIsPortable(filters);

    const tx = this.datastore.unwrap(options.tx);
    if (tx) {
      const victims = await this.findMany({ filters }, options);
      // Delete directly rather than via `delete()`, which would re-read each document —
      // and Firestore forbids a read after the first write in a transaction.
      for (const victim of victims) tx.delete(this.doc(victim.id));
      return victims.length;
    }

    return this.guard('deleteMany', async () => {
      let removed = 0;
      // Paged deletion: the retention sweep can target hundreds of thousands of telemetry
      // rows, which must never be loaded into memory in one go.
      for (;;) {
        const snapshot = await this.applyFilters(this.ref, filters)
          .limit(FirestoreRepository.MAX_BATCH_SIZE)
          .get();
        if (snapshot.empty) break;

        const batch = this.firestore.batch();
        for (const doc of snapshot.docs) batch.delete(doc.ref);
        await batch.commit();

        removed += snapshot.size;
        if (snapshot.size < FirestoreRepository.MAX_BATCH_SIZE) break;
      }
      return removed;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private doc(id: string): DocumentReference<DocumentData> {
    return this.ref.doc(id);
  }

  private applyFilters(base: Query<DocumentData>, filters: readonly QueryFilter[]): Query<DocumentData> {
    let query = base;
    for (const filter of filters) {
      query = query.where(filter.field, filter.op, filter.value);
    }
    return query;
  }

  private fromDocument(id: string, data: DocumentData | undefined): T {
    // `id` is duplicated into the document body, but the document key is authoritative.
    return { ...(data ?? {}), id } as T;
  }

  private mergePatch(current: T, patch: UpdateInput<T>, options: WriteOptions): T {
    return {
      ...current,
      ...stripImmutable(patch),
      id: current.id,
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      updatedAt: new Date().toISOString(),
      version: current.version + 1,
      ...(options.actor ? { updatedBy: options.actor.userId } : {}),
    } as T;
  }

  /** Wraps transport failures in the domain taxonomy while leaving AppErrors untouched. */
  private async guard<R>(operation: string, fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (error) {
      if (isDomainError(error)) throw error;
      throw new DatastoreError(`${this.collection}.${operation}`, error);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Identity and provenance fields are managed by the repository and never patchable. */
function stripImmutable<T>(patch: T): Record<string, unknown> {
  const { id, createdAt, createdBy, version, ...rest } = patch as Record<string, unknown>;
  void id;
  void createdAt;
  void createdBy;
  void version;
  return rest;
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

function entityLabel(collection: CollectionName): string {
  const words = collection.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
  const singular = words.endsWith('ies')
    ? `${words.slice(0, -3)}y`
    : words.endsWith('s')
      ? words.slice(0, -1)
      : words;
  return singular.charAt(0).toUpperCase() + singular.slice(1);
}

function grpcCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function isDomainError(error: unknown): boolean {
  return error instanceof Error && error.name.endsWith('Error') && 'statusCode' in error;
}

function chunked<V>(items: readonly V[], size: number): V[][] {
  const out: V[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
