import { Collections } from '@/constants/collections';
import type { IDatastore, IRepository, ReadOptions } from '@/interfaces/repository.port';
import { PolicyStatus, type Policy } from '@/models/policy.model';
import type { Page } from '@/types/common';

export class PolicyRepository {
  readonly base: IRepository<Policy>;

  constructor(datastore: IDatastore) {
    this.base = datastore.repository<Policy>(Collections.POLICIES);
  }

  /**
   * The single governing policy.
   *
   * Returns null when a deployment has none, which the service handles by seeding the
   * built-in default rather than failing — a platform without a policy cannot arbitrate,
   * and refusing to start would be a worse failure than seeding a documented baseline.
   */
  async findActive(options?: ReadOptions): Promise<Policy | null> {
    return this.base.findOne([{ field: 'status', op: '==', value: PolicyStatus.ACTIVE }], options);
  }

  /**
   * Every policy currently marked ACTIVE.
   *
   * Should always be zero or one. Exposed so `activate()` can detect and repair a split
   * state — which can only arise from direct datastore surgery, but an arbitration
   * platform that silently picks one of two conflicting policies is worse than one that
   * notices.
   */
  async findAllActive(options?: ReadOptions): Promise<Policy[]> {
    return this.base.findMany(
      { filters: [{ field: 'status', op: '==', value: PolicyStatus.ACTIVE }] },
      options,
    );
  }

  /** Highest revision number across the whole lineage, for minting the next one. */
  async highestRevision(options?: ReadOptions): Promise<number> {
    const [latest] = await this.base.findMany(
      { orderBy: [{ field: 'revision', direction: 'desc' }], limit: 1 },
      options,
    );
    return latest?.revision ?? 0;
  }

  async listByStatus(
    status: PolicyStatus | undefined,
    page: { limit: number; cursor?: string },
  ): Promise<Page<Policy>> {
    return this.base.paginate({
      limit: page.limit,
      cursor: page.cursor,
      filters: status ? [{ field: 'status', op: '==', value: status }] : [],
      orderBy: [{ field: 'revision', direction: 'desc' }],
    });
  }
}
