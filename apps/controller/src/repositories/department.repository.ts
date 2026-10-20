import { Collections } from '@/constants/collections';
import type { ComplianceLevel, DepartmentCriticality } from '@/constants/enums';
import type { IDatastore, IRepository, ReadOptions } from '@/interfaces/repository.port';
import type { Department } from '@/models/department.model';
import type { Page, QueryFilter } from '@/types/common';

export class DepartmentRepository {
  readonly base: IRepository<Department>;

  constructor(datastore: IDatastore) {
    this.base = datastore.repository<Department>(Collections.DEPARTMENTS);
  }

  /** Codes are unique; this is the uniqueness check performed on create. */
  async findByCode(code: string, options?: ReadOptions): Promise<Department | null> {
    return this.base.findOne([{ field: 'code', op: '==', value: code }], options);
  }

  /**
   * Every active department, used to build the arbitration snapshot.
   *
   * Deliberately unpaginated: the arbitration engine must reason about the WHOLE fleet at
   * once — a partial view would compute fairness multipliers and harm totals against a
   * subset and reach a different, wrong answer. Enterprise department counts are in the
   * tens, so a full read is the correct trade.
   */
  async listActive(options?: ReadOptions): Promise<Department[]> {
    return this.base.findMany(
      {
        filters: [{ field: 'active', op: '==', value: true }],
        orderBy: [{ field: 'name', direction: 'asc' }],
      },
      options,
    );
  }

  async listAll(options?: ReadOptions): Promise<Department[]> {
    return this.base.findMany({ orderBy: [{ field: 'name', direction: 'asc' }] }, options);
  }

  /** Bulk fetch keyed by id — avoids an N+1 when enriching a list of slices. */
  async mapByIds(ids: string[], options?: ReadOptions): Promise<Map<string, Department>> {
    const unique = [...new Set(ids)];
    const found = await this.base.findByIds(unique, options);
    const map = new Map<string, Department>();
    for (const department of found) {
      if (department) map.set(department.id, department);
    }
    return map;
  }

  async search(
    criteria: {
      criticality?: DepartmentCriticality;
      complianceLevel?: ComplianceLevel;
      active?: boolean;
    },
    page: { limit: number; cursor?: string },
  ): Promise<Page<Department>> {
    const filters: QueryFilter[] = [];
    if (criteria.criticality) {
      filters.push({ field: 'criticality', op: '==', value: criteria.criticality });
    }
    if (criteria.complianceLevel) {
      filters.push({ field: 'complianceLevel', op: '==', value: criteria.complianceLevel });
    }
    if (criteria.active !== undefined) {
      filters.push({ field: 'active', op: '==', value: criteria.active });
    }

    return this.base.paginate({
      limit: page.limit,
      cursor: page.cursor,
      filters,
      orderBy: [{ field: 'name', direction: 'asc' }],
    });
  }
}
