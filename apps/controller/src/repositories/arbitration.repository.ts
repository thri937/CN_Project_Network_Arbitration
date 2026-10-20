import { Collections } from '@/constants/collections';
import { ArbitrationOutcome, ArbitrationTrigger, RecoveryStatus } from '@/constants/enums';
import type { IDatastore, IRepository, ReadOptions } from '@/interfaces/repository.port';
import type { ArbitrationDecision } from '@/models/arbitrationDecision.model';
import type { Page, QueryFilter } from '@/types/common';

export class ArbitrationRepository {
  readonly base: IRepository<ArbitrationDecision>;

  constructor(datastore: IDatastore) {
    this.base = datastore.repository<ArbitrationDecision>(Collections.ARBITRATION_HISTORY);
  }

  /**
   * Decisions with degraded slices still awaiting restoration.
   *
   * Polled by the recovery scheduler. Filtering on `recoveryStatus` rather than scanning
   * every decision keeps the sweep O(open decisions) rather than O(all history) — which
   * matters after a year of operation.
   */
  async findAwaitingRecovery(nowMs: number, options?: ReadOptions): Promise<ArbitrationDecision[]> {
    return this.base.findMany(
      {
        filters: [
          {
            field: 'recoveryStatus',
            op: 'in',
            value: [RecoveryStatus.PENDING, RecoveryStatus.IN_PROGRESS, RecoveryStatus.EXTENDED],
          },
          { field: 'nextRecoveryAtMs', op: '<=', value: nowMs },
        ],
        orderBy: [{ field: 'nextRecoveryAtMs', direction: 'asc' }],
      },
      options,
    );
  }

  /** Every decision for one contention, oldest first. */
  async forContention(contentionId: string, options?: ReadOptions): Promise<ArbitrationDecision[]> {
    return this.base.findMany(
      {
        filters: [{ field: 'contentionId', op: '==', value: contentionId }],
        orderBy: [{ field: 'decidedAtMs', direction: 'asc' }],
      },
      options,
    );
  }

  /**
   * Decisions that degraded a given slice, within a time window.
   *
   * This is the query behind the fairness term: it reconstructs a slice's degradation
   * burden from the authoritative record rather than trusting a counter that could drift.
   */
  async affectingSlice(
    sliceId: string,
    fromMs: number,
    options?: ReadOptions,
  ): Promise<ArbitrationDecision[]> {
    return this.base.findMany(
      {
        filters: [
          { field: 'degradedSliceIds', op: 'array-contains', value: sliceId },
          { field: 'decidedAtMs', op: '>=', value: fromMs },
        ],
        orderBy: [{ field: 'decidedAtMs', direction: 'desc' }],
      },
      options,
    );
  }

  async recent(limit = 20): Promise<ArbitrationDecision[]> {
    return this.base.findMany({
      orderBy: [{ field: 'decidedAtMs', direction: 'desc' }],
      limit,
    });
  }

  async search(
    criteria: {
      contentionId?: string;
      outcome?: ArbitrationOutcome;
      trigger?: ArbitrationTrigger;
      fromMs?: number;
      toMs?: number;
    },
    page: { limit: number; cursor?: string },
  ): Promise<Page<ArbitrationDecision>> {
    const filters: QueryFilter[] = [];
    if (criteria.contentionId) {
      filters.push({ field: 'contentionId', op: '==', value: criteria.contentionId });
    }
    if (criteria.outcome) filters.push({ field: 'outcome', op: '==', value: criteria.outcome });
    if (criteria.trigger) filters.push({ field: 'trigger', op: '==', value: criteria.trigger });
    if (criteria.fromMs !== undefined) {
      filters.push({ field: 'decidedAtMs', op: '>=', value: criteria.fromMs });
    }
    if (criteria.toMs !== undefined) {
      filters.push({ field: 'decidedAtMs', op: '<=', value: criteria.toMs });
    }

    return this.base.paginate({
      limit: page.limit,
      cursor: page.cursor,
      filters,
      orderBy: [{ field: 'decidedAtMs', direction: 'desc' }],
    });
  }
}
