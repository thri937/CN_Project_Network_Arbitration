import { Collections } from '@/constants/collections';
import type { IDatastore, IRepository } from '@/interfaces/repository.port';
import type { TelemetrySample } from '@/models/telemetry.model';
import type { Page, QueryFilter } from '@/types/common';

export class TelemetryRepository {
  readonly base: IRepository<TelemetrySample>;

  constructor(datastore: IDatastore) {
    this.base = datastore.repository<TelemetrySample>(Collections.TELEMETRY);
  }

  /**
   * Bulk-append a tick's worth of samples.
   *
   * `createMany` is a single batched write per driver, which matters: one write per slice
   * per tick would be 20 round trips every two seconds and would dominate both latency and
   * Firestore cost.
   */
  async appendBatch(samples: Omit<TelemetrySample, 'id' | 'createdAt' | 'updatedAt' | 'version'>[]): Promise<void> {
    if (samples.length === 0) return;
    await this.base.createMany(samples);
  }

  /** Time-series for one slice, oldest first — the shape Recharts expects. */
  async seriesForSlice(sliceId: string, fromMs: number, toMs: number, limit = 500): Promise<TelemetrySample[]> {
    return this.base.findMany({
      filters: [
        { field: 'sliceId', op: '==', value: sliceId },
        { field: 'atMs', op: '>=', value: fromMs },
        { field: 'atMs', op: '<=', value: toMs },
      ],
      orderBy: [{ field: 'atMs', direction: 'asc' }],
      limit,
    });
  }

  async query(
    criteria: { sliceId?: string; departmentId?: string; fromMs?: number; toMs?: number },
    page: { limit: number; cursor?: string },
  ): Promise<Page<TelemetrySample>> {
    const filters: QueryFilter[] = [];
    if (criteria.sliceId) filters.push({ field: 'sliceId', op: '==', value: criteria.sliceId });
    if (criteria.departmentId) {
      filters.push({ field: 'departmentId', op: '==', value: criteria.departmentId });
    }
    if (criteria.fromMs !== undefined) filters.push({ field: 'atMs', op: '>=', value: criteria.fromMs });
    if (criteria.toMs !== undefined) filters.push({ field: 'atMs', op: '<=', value: criteria.toMs });

    return this.base.paginate({
      limit: page.limit,
      cursor: page.cursor,
      filters,
      orderBy: [{ field: 'atMs', direction: 'desc' }],
    });
  }

  /** Retention sweep. Returns the number of samples removed. */
  async pruneOlderThan(cutoffMs: number): Promise<number> {
    return this.base.deleteMany([{ field: 'atMs', op: '<', value: cutoffMs }]);
  }
}
