import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Collections } from '@/constants/collections';
import { ErrorCode } from '@/constants/errorCodes';
import type { IDatastore, IRepository } from '@/interfaces/repository.port';
import { MemoryDatastore } from '@/repositories/memory/memory.datastore';
import { FirestoreDatastore } from '@/repositories/firestore/firestore.datastore';
import type { AuditableEntity } from '@/types/common';
import { AppError } from '@/utils/errors';

/**
 * REPOSITORY CONTRACT SUITE
 * =========================
 * The same assertions run against every `IDatastore` implementation. This is the
 * mechanism that makes the hexagonal claim real rather than aspirational: if the Firestore
 * and in-memory drivers ever diverge on ordering, cursor semantics, optimistic locking or
 * transaction isolation, this suite fails.
 *
 * The Firestore driver participates automatically when `FIRESTORE_EMULATOR_HOST` is set:
 *
 *   firebase emulators:start --only firestore
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 npm test
 *
 * It is skipped — not silently passed — when the emulator is absent, so a green run
 * without the emulator never claims more than it verified.
 */

interface TestEntity extends AuditableEntity {
  name: string;
  score: number;
  status: string;
  tags: string[];
  nested: { level: number };
}

const TEST_COLLECTION = Collections.DEPARTMENTS;

interface DriverCase {
  name: string;
  create: () => Promise<IDatastore>;
  enabled: boolean;
}

const drivers: DriverCase[] = [
  {
    name: 'memory',
    enabled: true,
    create: async () => {
      const datastore = new MemoryDatastore({ persist: false });
      await datastore.initialise();
      return datastore;
    },
  },
  {
    name: 'firestore(emulator)',
    enabled: Boolean(process.env.FIRESTORE_EMULATOR_HOST),
    create: async () => new FirestoreDatastore(),
  },
];

for (const driver of drivers) {
  const suite = driver.enabled ? describe : describe.skip;

  suite(`IRepository contract — ${driver.name}`, () => {
    let datastore: IDatastore;
    let repo: IRepository<TestEntity>;

    const seed = (overrides: Partial<TestEntity> = {}) => ({
      name: 'Manufacturing',
      score: 50,
      status: 'ACTIVE',
      tags: ['ot', 'plant'],
      nested: { level: 1 },
      ...overrides,
    });

    beforeAll(async () => {
      datastore = await driver.create();
      repo = datastore.repository<TestEntity>(TEST_COLLECTION);
    });

    afterEach(async () => {
      // Full wipe between tests so ordering and pagination assertions are deterministic.
      const all = await repo.findMany();
      for (const entity of all) await repo.delete(entity.id);
    });

    afterAll(async () => {
      await datastore.dispose();
    });

    /* ---------------------------------------------------------------- */
    describe('create', () => {
      it('stamps audit fields and mints a prefixed id', async () => {
        const created = await repo.create(seed());

        expect(created.id).toMatch(/^DEP-/);
        expect(created.version).toBe(1);
        expect(created.createdAt).toBe(created.updatedAt);
        expect(new Date(created.createdAt).toString()).not.toBe('Invalid Date');
        expect(created.name).toBe('Manufacturing');
      });

      it('honours a caller-supplied id', async () => {
        const created = await repo.create(seed({ id: 'DEP-EXPLICIT-01' } as Partial<TestEntity>));
        expect(created.id).toBe('DEP-EXPLICIT-01');
        expect((await repo.getById('DEP-EXPLICIT-01')).name).toBe('Manufacturing');
      });

      it('rejects a duplicate id rather than overwriting', async () => {
        await repo.create(seed({ id: 'DEP-DUP' } as Partial<TestEntity>));
        await expect(repo.create(seed({ id: 'DEP-DUP', name: 'Other' } as Partial<TestEntity>)))
          .rejects.toMatchObject({ code: ErrorCode.ALREADY_EXISTS });

        // The original must be intact — a failed create may not have partially applied.
        expect((await repo.getById('DEP-DUP')).name).toBe('Manufacturing');
      });

      it('records the acting user', async () => {
        const created = await repo.create(seed(), {
          actor: {
            userId: 'USR-1',
            email: 'ops@corp.example',
            role: 'ADMIN',
            correlationId: 'c-1',
          },
        });
        expect(created.createdBy).toBe('USR-1');
        expect(created.updatedBy).toBe('USR-1');
      });

      it('creates many in one call', async () => {
        const created = await repo.createMany([seed({ name: 'A' }), seed({ name: 'B' })]);
        expect(created).toHaveLength(2);
        expect(await repo.count()).toBe(2);
      });
    });

    /* ---------------------------------------------------------------- */
    describe('read', () => {
      it('returns null for a missing document but throws from getById', async () => {
        expect(await repo.findById('DEP-NOPE')).toBeNull();
        await expect(repo.getById('DEP-NOPE')).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
          statusCode: 404,
        });
      });

      it('reports existence', async () => {
        const created = await repo.create(seed());
        expect(await repo.exists(created.id)).toBe(true);
        expect(await repo.exists('DEP-NOPE')).toBe(false);
      });

      it('preserves caller ordering and reports misses in findByIds', async () => {
        const a = await repo.create(seed({ name: 'A' }));
        const b = await repo.create(seed({ name: 'B' }));

        const result = await repo.findByIds([b.id, 'DEP-MISSING', a.id]);
        expect(result.map((e) => e?.name ?? null)).toEqual(['B', null, 'A']);
      });

      it('returns an empty array for an empty id list without querying', async () => {
        expect(await repo.findByIds([])).toEqual([]);
      });

      it('does not hand out references into the backing store', async () => {
        // Critical for driver equivalence: mutating a returned object must not change
        // persisted state, or code that works on `memory` breaks on Firestore.
        const created = await repo.create(seed());
        created.name = 'MUTATED';
        created.nested.level = 999;

        const reloaded = await repo.getById(created.id);
        expect(reloaded.name).toBe('Manufacturing');
        expect(reloaded.nested.level).toBe(1);
      });
    });

    /* ---------------------------------------------------------------- */
    describe('query', () => {
      beforeEach(async () => {
        await repo.createMany([
          seed({ name: 'Alpha', score: 10, status: 'ACTIVE', tags: ['x'] }),
          seed({ name: 'Bravo', score: 20, status: 'ACTIVE', tags: ['x', 'y'] }),
          seed({ name: 'Charlie', score: 30, status: 'PAUSED', tags: ['y'] }),
          seed({ name: 'Delta', score: 40, status: 'PAUSED', tags: ['z'] }),
        ]);
      });

      it('filters by equality', async () => {
        const rows = await repo.findMany({ filters: [{ field: 'status', op: '==', value: 'ACTIVE' }] });
        expect(rows.map((r) => r.name).sort()).toEqual(['Alpha', 'Bravo']);
      });

      it('filters by range', async () => {
        const rows = await repo.findMany({
          filters: [
            { field: 'score', op: '>=', value: 20 },
            { field: 'score', op: '<', value: 40 },
          ],
        });
        expect(rows.map((r) => r.name).sort()).toEqual(['Bravo', 'Charlie']);
      });

      it('filters by membership', async () => {
        const rows = await repo.findMany({
          filters: [{ field: 'name', op: 'in', value: ['Alpha', 'Delta'] }],
        });
        expect(rows.map((r) => r.name).sort()).toEqual(['Alpha', 'Delta']);
      });

      it('filters by array containment', async () => {
        const rows = await repo.findMany({
          filters: [{ field: 'tags', op: 'array-contains', value: 'y' }],
        });
        expect(rows.map((r) => r.name).sort()).toEqual(['Bravo', 'Charlie']);
      });

      it('filters on a nested field', async () => {
        const rows = await repo.findMany({
          filters: [{ field: 'nested.level', op: '==', value: 1 }],
        });
        expect(rows).toHaveLength(4);
      });

      it('orders ascending and descending', async () => {
        const asc = await repo.findMany({ orderBy: [{ field: 'score', direction: 'asc' }] });
        expect(asc.map((r) => r.score)).toEqual([10, 20, 30, 40]);

        const desc = await repo.findMany({ orderBy: [{ field: 'score', direction: 'desc' }] });
        expect(desc.map((r) => r.score)).toEqual([40, 30, 20, 10]);
      });

      it('applies a limit', async () => {
        const rows = await repo.findMany({
          orderBy: [{ field: 'score', direction: 'asc' }],
          limit: 2,
        });
        expect(rows.map((r) => r.score)).toEqual([10, 20]);
      });

      it('returns the first match from findOne', async () => {
        const found = await repo.findOne([{ field: 'name', op: '==', value: 'Charlie' }]);
        expect(found?.score).toBe(30);
        expect(await repo.findOne([{ field: 'name', op: '==', value: 'Nothing' }])).toBeNull();
      });

      it('counts with and without filters', async () => {
        expect(await repo.count()).toBe(4);
        expect(await repo.count([{ field: 'status', op: '==', value: 'PAUSED' }])).toBe(2);
      });

      it('rejects a non-portable query instead of failing only in production', async () => {
        // Firestore caps disjunctions at 30. Enforcing it in BOTH drivers means a query
        // that works locally cannot blow up after deployment.
        await expect(
          repo.findMany({
            filters: [
              { field: 'name', op: 'in', value: Array.from({ length: 31 }, (_, i) => `n${i}`) },
            ],
          }),
        ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });

        await expect(
          repo.findMany({ filters: [{ field: 'name', op: 'in', value: [] }] }),
        ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
      });
    });

    /* ---------------------------------------------------------------- */
    describe('pagination', () => {
      it('walks the full collection without gaps or repeats', async () => {
        await repo.createMany(
          Array.from({ length: 25 }, (_, i) => seed({ name: `Row-${String(i).padStart(2, '0')}`, score: i })),
        );

        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;

        do {
          const page = await repo.paginate({
            limit: 7,
            cursor,
            orderBy: [{ field: 'score', direction: 'asc' }],
          });
          seen.push(...page.items.map((i) => i.name));
          cursor = page.nextCursor ?? undefined;
          pages += 1;
          expect(pages).toBeLessThan(10); // guard against a non-advancing cursor
        } while (cursor);

        expect(seen).toHaveLength(25);
        expect(new Set(seen).size).toBe(25);
        expect(seen).toEqual([...seen].sort());
      });

      it('paginates correctly when the sort field has ties', async () => {
        // Without `id` appended as a tiebreaker the relative order of equal-scored rows is
        // unspecified, and a cursor can skip or duplicate them.
        await repo.createMany(Array.from({ length: 12 }, () => seed({ score: 100 })));

        const seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await repo.paginate({
            limit: 5,
            cursor,
            orderBy: [{ field: 'score', direction: 'desc' }],
          });
          for (const item of page.items) seen.add(item.id);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);

        expect(seen.size).toBe(12);
      });

      it('returns a null cursor on the final page', async () => {
        await repo.createMany([seed(), seed()]);
        const page = await repo.paginate({ limit: 10 });
        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).toBeNull();
      });

      it('handles an empty collection', async () => {
        const page = await repo.paginate({ limit: 10 });
        expect(page.items).toEqual([]);
        expect(page.nextCursor).toBeNull();
      });

      it('includes a total only when asked', async () => {
        await repo.createMany([seed(), seed(), seed()]);
        expect((await repo.paginate({ limit: 2 })).total).toBeUndefined();
        expect((await repo.paginate({ limit: 2, includeTotal: true })).total).toBe(3);
      });

      it('rejects a malformed cursor', async () => {
        await expect(repo.paginate({ limit: 5, cursor: 'not-a-cursor' })).rejects.toMatchObject({
          code: ErrorCode.VALIDATION_FAILED,
        });
      });

      it('rejects a cursor issued under a different sort order', async () => {
        await repo.createMany(Array.from({ length: 6 }, (_, i) => seed({ score: i })));

        const first = await repo.paginate({
          limit: 2,
          orderBy: [{ field: 'score', direction: 'asc' }],
        });
        expect(first.nextCursor).toBeTruthy();

        await expect(
          repo.paginate({
            limit: 2,
            cursor: first.nextCursor!,
            orderBy: [{ field: 'name', direction: 'desc' }],
          }),
        ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
      });
    });

    /* ---------------------------------------------------------------- */
    describe('update', () => {
      it('applies a partial patch and bumps the version', async () => {
        const created = await repo.create(seed());
        const updated = await repo.update(created.id, { score: 99 });

        expect(updated.score).toBe(99);
        expect(updated.name).toBe('Manufacturing'); // untouched fields preserved
        expect(updated.version).toBe(2);
        expect(updated.createdAt).toBe(created.createdAt);
      });

      it('refuses to let a patch rewrite identity or provenance', async () => {
        const created = await repo.create(seed());
        const updated = await repo.update(created.id, {
          name: 'Renamed',
          createdAt: '1999-01-01T00:00:00.000Z',
        } as never);

        expect(updated.id).toBe(created.id);
        expect(updated.createdAt).toBe(created.createdAt);
        expect(updated.name).toBe('Renamed');
      });

      it('throws when the target does not exist', async () => {
        await expect(repo.update('DEP-NOPE', { score: 1 })).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
        });
      });

      it('enforces optimistic concurrency', async () => {
        const created = await repo.create(seed());
        await repo.update(created.id, { score: 1 }); // version → 2

        await expect(
          repo.update(created.id, { score: 2 }, { expectedVersion: created.version }),
        ).rejects.toMatchObject({ code: ErrorCode.CONCURRENT_MODIFICATION, statusCode: 409 });

        // The correct version still succeeds.
        const ok = await repo.update(created.id, { score: 3 }, { expectedVersion: 2 });
        expect(ok.score).toBe(3);
        expect(ok.version).toBe(3);
      });

      it('creates on upsert when absent and patches when present', async () => {
        const first = await repo.upsert('DEP-SINGLETON', seed({ score: 1 }));
        expect(first.version).toBe(1);

        const second = await repo.upsert('DEP-SINGLETON', seed({ score: 2 }));
        expect(second.version).toBe(2);
        expect(second.score).toBe(2);
        expect(await repo.count()).toBe(1);
      });

      it('supports read-modify-write via mutate', async () => {
        const created = await repo.create(seed({ score: 10 }));
        const mutated = await repo.mutate(created.id, (current) => ({ score: current.score * 3 }));
        expect(mutated.score).toBe(30);
      });
    });

    /* ---------------------------------------------------------------- */
    describe('delete', () => {
      it('removes a document', async () => {
        const created = await repo.create(seed());
        await repo.delete(created.id);
        expect(await repo.findById(created.id)).toBeNull();
      });

      it('distinguishes "already gone" from "never existed"', async () => {
        await expect(repo.delete('DEP-NOPE')).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
        });
      });

      it('honours optimistic concurrency', async () => {
        const created = await repo.create(seed());
        await repo.update(created.id, { score: 1 });
        await expect(repo.delete(created.id, { expectedVersion: 1 })).rejects.toMatchObject({
          code: ErrorCode.CONCURRENT_MODIFICATION,
        });
      });

      it('deletes matching documents in bulk', async () => {
        await repo.createMany([
          seed({ status: 'ACTIVE' }),
          seed({ status: 'PAUSED' }),
          seed({ status: 'PAUSED' }),
        ]);

        const removed = await repo.deleteMany([{ field: 'status', op: '==', value: 'PAUSED' }]);
        expect(removed).toBe(2);
        expect(await repo.count()).toBe(1);
      });
    });

    /* ---------------------------------------------------------------- */
    describe('transactions', () => {
      it('commits every enlisted write atomically', async () => {
        await datastore.runTransaction(async (tx) => {
          await repo.create(seed({ id: 'DEP-TX-A', name: 'A' } as Partial<TestEntity>), { tx });
          await repo.create(seed({ id: 'DEP-TX-B', name: 'B' } as Partial<TestEntity>), { tx });
        });

        expect(await repo.exists('DEP-TX-A')).toBe(true);
        expect(await repo.exists('DEP-TX-B')).toBe(true);
      });

      it('applies nothing when the callback throws', async () => {
        // This is the guarantee Module 9 depends on: an arbitration plan either degrades
        // every targeted slice and writes its audit record, or changes nothing at all.
        await expect(
          datastore.runTransaction(async (tx) => {
            await repo.create(seed({ id: 'DEP-TX-C' } as Partial<TestEntity>), { tx });
            throw new AppError('deliberate failure', 500, ErrorCode.INTERNAL_ERROR);
          }),
        ).rejects.toThrow('deliberate failure');

        expect(await repo.exists('DEP-TX-C')).toBe(false);
      });

      it('rejects a read issued after a write', async () => {
        // Firestore requires all reads before all writes. The in-memory driver enforces
        // the same rule deliberately: a development driver that is MORE permissive than
        // production lets a developer write code that cannot possibly work once deployed.
        await expect(
          datastore.runTransaction(async (tx) => {
            await repo.create(seed({ id: 'DEP-TX-ORDER' } as Partial<TestEntity>), { tx });
            return repo.findById('DEP-TX-ORDER', { tx });
          }),
        ).rejects.toThrow();

        expect(await repo.exists('DEP-TX-ORDER')).toBe(false);
      });

      it('reads observe the committed snapshot, not staged writes', async () => {
        await repo.create(seed({ id: 'DEP-TX-SNAP', score: 1 } as Partial<TestEntity>));

        const observed = await datastore.runTransaction(async (tx) => {
          // Read-then-write is the legal ordering. The read sees committed state.
          const before = await repo.findById('DEP-TX-SNAP', { tx });
          await repo.update('DEP-TX-SNAP', { score: 42 }, { tx });
          return before?.score ?? null;
        });

        expect(observed).toBe(1);
        expect((await repo.getById('DEP-TX-SNAP')).score).toBe(42);
      });

      it('does not expose uncommitted writes to readers outside the transaction', async () => {
        let leaked: TestEntity | null = null;

        await datastore.runTransaction(async (tx) => {
          await repo.create(seed({ id: 'DEP-TX-E' } as Partial<TestEntity>), { tx });
          leaked = await repo.findById('DEP-TX-E'); // no tx → committed state only
        });

        expect(leaked).toBeNull();
        expect(await repo.exists('DEP-TX-E')).toBe(true);
      });

      it('commits a transactional delete', async () => {
        await repo.create(seed({ id: 'DEP-TX-F' } as Partial<TestEntity>));

        await datastore.runTransaction(async (tx) => {
          // Read first (the delete needs the current version), then write.
          await repo.delete('DEP-TX-F', { tx });
        });

        expect(await repo.exists('DEP-TX-F')).toBe(false);
      });

      it('deletes many inside a transaction without violating read ordering', async () => {
        await repo.createMany([
          seed({ status: 'DOOMED' }),
          seed({ status: 'DOOMED' }),
          seed({ status: 'DOOMED' }),
          seed({ status: 'KEEP' }),
        ]);

        const removed = await datastore.runTransaction((tx) =>
          repo.deleteMany([{ field: 'status', op: '==', value: 'DOOMED' }], { tx }),
        );

        expect(removed).toBe(3);
        expect(await repo.count()).toBe(1);
      });

      it('rejects a duplicate id staged inside a transaction', async () => {
        await repo.create(seed({ id: 'DEP-TX-G' } as Partial<TestEntity>));

        await expect(
          datastore.runTransaction(async (tx) => {
            await repo.create(seed({ id: 'DEP-TX-G', name: 'Clobber' } as Partial<TestEntity>), { tx });
          }),
        ).rejects.toThrow();

        expect((await repo.getById('DEP-TX-G')).name).toBe('Manufacturing');
      });

      it('returns the callback result', async () => {
        const result = await datastore.runTransaction(async () => 'done');
        expect(result).toBe('done');
      });

      it('applies several write-only updates atomically', async () => {
        // The read-all → compute → write-all pattern. `update()` cannot be used more than
        // once in a transaction because it reads; `applyUpdate()` exists precisely for this.
        const a = await repo.create(seed({ id: 'DEP-MW-A', score: 1 } as Partial<TestEntity>));
        const b = await repo.create(seed({ id: 'DEP-MW-B', score: 2 } as Partial<TestEntity>));
        const c = await repo.create(seed({ id: 'DEP-MW-C', score: 3 } as Partial<TestEntity>));

        await datastore.runTransaction(async (tx) => {
          // reads
          const loaded = await repo.findByIds([a.id, b.id, c.id], { tx });
          // writes
          for (const entity of loaded) {
            if (!entity) continue;
            await repo.applyUpdate(entity, { score: entity.score * 10 }, { tx });
          }
        });

        expect((await repo.getById(a.id)).score).toBe(10);
        expect((await repo.getById(b.id)).score).toBe(20);
        expect((await repo.getById(c.id)).score).toBe(30);
      });

      it('rolls back every write-only update when the callback throws', async () => {
        const a = await repo.create(seed({ id: 'DEP-MW-R1', score: 1 } as Partial<TestEntity>));
        const b = await repo.create(seed({ id: 'DEP-MW-R2', score: 2 } as Partial<TestEntity>));

        await expect(
          datastore.runTransaction(async (tx) => {
            const [loadedA, loadedB] = await repo.findByIds([a.id, b.id], { tx });
            await repo.applyUpdate(loadedA!, { score: 100 }, { tx });
            await repo.applyUpdate(loadedB!, { score: 200 }, { tx });
            throw new AppError('rollback', 500, ErrorCode.INTERNAL_ERROR);
          }),
        ).rejects.toThrow('rollback');

        expect((await repo.getById(a.id)).score).toBe(1);
        expect((await repo.getById(b.id)).score).toBe(2);
      });

      it('enforces optimistic concurrency on a write-only update', async () => {
        const entity = await repo.create(seed({ id: 'DEP-MW-V' } as Partial<TestEntity>));
        const stale = { ...entity, version: 99 };

        await expect(repo.applyUpdate(stale, { score: 5 }, { expectedVersion: 1 })).rejects.toMatchObject(
          { code: ErrorCode.CONCURRENT_MODIFICATION },
        );
      });

      it('supports write-only deletes alongside updates', async () => {
        const keep = await repo.create(seed({ id: 'DEP-MW-K', score: 1 } as Partial<TestEntity>));
        const drop = await repo.create(seed({ id: 'DEP-MW-D', score: 2 } as Partial<TestEntity>));

        await datastore.runTransaction(async (tx) => {
          const [loadedKeep, loadedDrop] = await repo.findByIds([keep.id, drop.id], { tx });
          await repo.applyUpdate(loadedKeep!, { score: 99 }, { tx });
          await repo.applyDelete(loadedDrop!, { tx });
        });

        expect((await repo.getById(keep.id)).score).toBe(99);
        expect(await repo.exists(drop.id)).toBe(false);
      });
    });
  });
}
