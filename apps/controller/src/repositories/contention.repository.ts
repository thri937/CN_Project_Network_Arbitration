import { Collections } from '@/constants/collections';
import type { ContentionSeverity, ContentionStatus } from '@/constants/enums';
import type { IDatastore, IRepository, ReadOptions } from '@/interfaces/repository.port';
import { OPEN_CONTENTION_STATUSES, type ContentionEvent } from '@/models/contention.model';
import type { Page, QueryFilter } from '@/types/common';

export class ContentionRepository {
  readonly base: IRepository<ContentionEvent>;

  constructor(datastore: IDatastore) {
    this.base = datastore.repository<ContentionEvent>(Collections.CONTENTION_EVENTS);
  }

  /**
   * The currently open contention event, if any.
   *
   * At most ONE contention event is open at a time. Contention is a property of the whole
   * network, not of an individual slice: total demand either exceeds total capacity or it
   * does not. Modelling it per-slice would produce N simultaneous "events" for a single
   * physical condition and would let N arbitration passes race each other over the same
   * capacity.
   */
  async findOpen(options?: ReadOptions): Promise<ContentionEvent | null> {
    const open = await this.base.findMany(
      {
        filters: [{ field: 'status', op: 'in', value: [...OPEN_CONTENTION_STATUSES] }],
        orderBy: [{ field: 'detectedAtMs', direction: 'desc' }],
        limit: 1,
      },
      options,
    );
    return open[0] ?? null;
  }

  /** Every open event. Should be zero or one; used to detect and repair a split state. */
  async findAllOpen(options?: ReadOptions): Promise<ContentionEvent[]> {
    return this.base.findMany(
      { filters: [{ field: 'status', op: 'in', value: [...OPEN_CONTENTION_STATUSES] }] },
      options,
    );
  }

  async search(
    criteria: {
      status?: ContentionStatus;
      severity?: ContentionSeverity;
      fromMs?: number;
      toMs?: number;
    },
    page: { limit: number; cursor?: string },
  ): Promise<Page<ContentionEvent>> {
    const filters: QueryFilter[] = [];
    if (criteria.status) filters.push({ field: 'status', op: '==', value: criteria.status });
    if (criteria.severity) filters.push({ field: 'severity', op: '==', value: criteria.severity });
    if (criteria.fromMs !== undefined) {
      filters.push({ field: 'detectedAtMs', op: '>=', value: criteria.fromMs });
    }
    if (criteria.toMs !== undefined) {
      filters.push({ field: 'detectedAtMs', op: '<=', value: criteria.toMs });
    }

    return this.base.paginate({
      limit: page.limit,
      cursor: page.cursor,
      filters,
      orderBy: [{ field: 'detectedAtMs', direction: 'desc' }],
    });
  }

  async recent(limit = 20): Promise<ContentionEvent[]> {
    return this.base.findMany({
      orderBy: [{ field: 'detectedAtMs', direction: 'desc' }],
      limit,
    });
  }
}
