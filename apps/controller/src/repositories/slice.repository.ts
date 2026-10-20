import { Collections } from '@/constants/collections';
import { ARBITRABLE_SLICE_STATUSES, SliceStatus, type HealthState, type SliceProfile } from '@/constants/enums';
import type { IDatastore, IRepository, ReadOptions } from '@/interfaces/repository.port';
import type { Slice } from '@/models/slice.model';
import type { Page, QueryFilter } from '@/types/common';

export class SliceRepository {
  readonly base: IRepository<Slice>;

  constructor(datastore: IDatastore) {
    this.base = datastore.repository<Slice>(Collections.SLICES);
  }

  async findByCode(code: string, options?: ReadOptions): Promise<Slice | null> {
    return this.base.findOne([{ field: 'code', op: '==', value: code }], options);
  }

  /**
   * Every slice that consumes capacity, i.e. participates in arbitration.
   *
   * Deliberately unpaginated. Arbitration is a GLOBAL optimisation: harm totals, fairness
   * multipliers and the feasibility check are all defined over the complete fleet. Running
   * it against a page would produce a confidently-explained wrong answer, which is worse
   * than no answer at all.
   */
  async listArbitrable(options?: ReadOptions): Promise<Slice[]> {
    return this.base.findMany(
      {
        filters: [{ field: 'status', op: 'in', value: [...ARBITRABLE_SLICE_STATUSES] }],
        orderBy: [{ field: 'code', direction: 'asc' }],
      },
      options,
    );
  }

  async listByDepartment(departmentId: string, options?: ReadOptions): Promise<Slice[]> {
    return this.base.findMany(
      {
        filters: [{ field: 'departmentId', op: '==', value: departmentId }],
        orderBy: [{ field: 'code', direction: 'asc' }],
      },
      options,
    );
  }

  async countByDepartment(departmentId: string, options?: ReadOptions): Promise<number> {
    return this.base.count([{ field: 'departmentId', op: '==', value: departmentId }], options);
  }

  /** Slices currently carrying an applied degradation — drives the recovery scheduler. */
  async listDegraded(options?: ReadOptions): Promise<Slice[]> {
    return this.base.findMany(
      { filters: [{ field: 'status', op: '==', value: SliceStatus.DEGRADED }] },
      options,
    );
  }

  async listAll(options?: ReadOptions): Promise<Slice[]> {
    return this.base.findMany({ orderBy: [{ field: 'code', direction: 'asc' }] }, options);
  }

  async search(
    criteria: {
      departmentId?: string;
      status?: SliceStatus;
      profile?: SliceProfile;
      health?: HealthState;
    },
    page: { limit: number; cursor?: string },
  ): Promise<Page<Slice>> {
    const filters: QueryFilter[] = [];
    if (criteria.departmentId) {
      filters.push({ field: 'departmentId', op: '==', value: criteria.departmentId });
    }
    if (criteria.status) filters.push({ field: 'status', op: '==', value: criteria.status });
    if (criteria.profile) filters.push({ field: 'profile', op: '==', value: criteria.profile });
    if (criteria.health) filters.push({ field: 'health', op: '==', value: criteria.health });

    return this.base.paginate({
      limit: page.limit,
      cursor: page.cursor,
      filters,
      orderBy: [{ field: 'code', direction: 'asc' }],
    });
  }

  /**
   * Total contractual floor across arbitrable slices.
   *
   * This is the number admission control compares against offered capacity: if the sum of
   * guaranteed minimums exceeds what the network can offer, no arbitration plan can exist.
   */
  async totalGuaranteedMbps(options?: ReadOptions): Promise<number> {
    const slices = await this.listArbitrable(options);
    return slices.reduce((total, slice) => total + slice.minGuaranteedMbps, 0);
  }

  async totalAllocatedMbps(options?: ReadOptions): Promise<number> {
    const slices = await this.listArbitrable(options);
    return slices.reduce((total, slice) => total + slice.allocatedMbps, 0);
  }
}
