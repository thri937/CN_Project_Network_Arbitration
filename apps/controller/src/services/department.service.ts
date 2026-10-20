import { Collections } from '@/constants/collections';
import { AuditAction, ARBITRABLE_SLICE_STATUSES } from '@/constants/enums';
import type { ComplianceLevel, DepartmentCriticality } from '@/constants/enums';
import type { IDatastore } from '@/interfaces/repository.port';
import { diffFields } from '@/models/auditLog.model';
import {
  deriveCode,
  effectiveDegradationCeiling,
  validateComplianceCeiling,
  type CreateDepartmentPayload,
  type Department,
  type UpdateDepartmentPayload,
} from '@/models/department.model';
import type { DepartmentRepository } from '@/repositories/department.repository';
import type { ActorContext, AuditableEntity, Page } from '@/types/common';
import { AlreadyExistsError, PolicyViolationError, ResourceInUseError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';
import type { AuditService } from './audit.service';

const log = createLogger('department-service');

/**
 * Department lifecycle.
 *
 * Two rules here are load-bearing for the arbitration engine downstream, and both are
 * enforced at write time rather than being re-checked on every arbitration run:
 *
 *   R1. `maxAllowedDegradationPercent` may never exceed the ceiling implied by
 *       `complianceLevel`. Validated on create, and re-validated against the MERGED entity
 *       on update — a partial patch that changes only `complianceLevel` must not be able to
 *       leave a previously-legal degradation limit stranded above the new ceiling.
 *
 *   R2. A department with slices still attached cannot be deleted. Orphaned slices would
 *       enter the arbitration snapshot with no business context, and the engine would have
 *       no defensible basis on which to rank them.
 */
export class DepartmentService {
  constructor(
    private readonly departments: DepartmentRepository,
    private readonly datastore: IDatastore,
    private readonly audit: AuditService,
  ) {}

  async create(payload: CreateDepartmentPayload, actor: ActorContext): Promise<Department> {
    const code = payload.code ?? deriveCode(payload.name);
    if (!code) {
      throw new PolicyViolationError('A department code could not be derived from the name', {
        name: payload.name,
      });
    }

    const existing = await this.departments.findByCode(code);
    if (existing) throw new AlreadyExistsError('Department', 'code', code);

    const created = await this.departments.base.create(
      {
        ...payload,
        code,
        policyWeightMultiplier: payload.policyWeightMultiplier ?? 1,
        escalationContacts: payload.escalationContacts ?? [],
        tags: payload.tags ?? [],
        active: payload.active ?? true,
      },
      { actor },
    );

    await this.audit.record({
      action: AuditAction.DEPARTMENT_CREATED,
      actor,
      summary: `Department '${created.name}' created (${created.criticality}, max degradation ${effectiveDegradationCeiling(created)}%)`,
      target: { type: 'Department', id: created.id, name: created.name },
      changes: diffFields({}, payload as Record<string, unknown>),
    });

    log.info({ departmentId: created.id, code }, 'department created');
    return created;
  }

  async getById(id: string): Promise<Department> {
    return this.departments.base.getById(id);
  }

  async list(
    criteria: {
      criticality?: DepartmentCriticality;
      complianceLevel?: ComplianceLevel;
      active?: boolean;
    },
    page: { limit: number; cursor?: string },
  ): Promise<Page<Department>> {
    return this.departments.search(criteria, page);
  }

  async listActive(): Promise<Department[]> {
    return this.departments.listActive();
  }

  async update(
    id: string,
    payload: UpdateDepartmentPayload,
    actor: ActorContext,
  ): Promise<Department> {
    const current = await this.departments.base.getById(id);

    // R1 — validate against the merged entity, not the patch. A patch touching only
    // `complianceLevel` still has to be checked against the EXISTING degradation limit.
    const merged = {
      complianceLevel: payload.complianceLevel ?? current.complianceLevel,
      maxAllowedDegradationPercent:
        payload.maxAllowedDegradationPercent ?? current.maxAllowedDegradationPercent,
    };
    const check = validateComplianceCeiling(merged);
    if (!check.ok) {
      throw new PolicyViolationError(
        `Compliance level ${merged.complianceLevel} caps degradation at ${check.ceiling}%; ` +
          `this department is configured for ${merged.maxAllowedDegradationPercent}%. ` +
          `Lower maxAllowedDegradationPercent in the same request.`,
        { departmentId: id, ceiling: check.ceiling, configured: merged.maxAllowedDegradationPercent },
      );
    }

    const updated = await this.departments.base.update(id, payload, {
      actor,
      expectedVersion: current.version,
    });

    await this.audit.record({
      action: AuditAction.DEPARTMENT_UPDATED,
      actor,
      summary: `Department '${updated.name}' updated`,
      target: { type: 'Department', id, name: updated.name },
      changes: diffFields(
        current as unknown as Record<string, unknown>,
        payload as Record<string, unknown>,
      ),
    });

    log.info({ departmentId: id, fields: Object.keys(payload) }, 'department updated');
    return updated;
  }

  /**
   * Delete a department.
   *
   * R2 is checked inside a transaction: without atomicity a slice could be created
   * against the department between the check and the delete, leaving it orphaned.
   */
  async delete(id: string, actor: ActorContext): Promise<void> {
    const department = await this.datastore.runTransaction(async (tx) => {
      // --- reads first ---
      const current = await this.departments.base.getById(id, { tx });

      const attachedSlices = await this.datastore
        .repository(Collections.SLICES)
        .count([{ field: 'departmentId', op: '==', value: id }], { tx });

      if (attachedSlices > 0) {
        throw new ResourceInUseError('Department', id, 'slices', attachedSlices);
      }

      // --- writes ---
      await this.departments.base.delete(id, { tx, expectedVersion: current.version });
      return current;
    }, `department.delete:${id}`);

    await this.audit.record({
      action: AuditAction.DEPARTMENT_DELETED,
      actor,
      summary: `Department '${department.name}' deleted`,
      target: { type: 'Department', id, name: department.name },
    });

    log.info({ departmentId: id }, 'department deleted');
  }

  /**
   * Operational summary for the dashboard: how many slices each department runs and how
   * much bandwidth it holds.
   *
   * One read of each collection followed by an in-memory join, rather than a per-department
   * query. With tens of departments and hundreds of slices this is a single-digit number of
   * reads instead of N+1.
   */
  async summarise(): Promise<DepartmentSummary[]> {
    const [departments, slices] = await Promise.all([
      this.departments.listAll(),
      // Typed structurally rather than importing the Slice model: this service must not
      // depend on Module 4, and it only needs three fields to build the roll-up.
      this.datastore
        .repository<SliceProjection>(Collections.SLICES)
        .findMany(),
    ]);

    const byDepartment = new Map<string, { count: number; allocated: number; degraded: number }>();
    for (const slice of slices) {
      const bucket = byDepartment.get(slice.departmentId) ?? { count: 0, allocated: 0, degraded: 0 };
      bucket.count += 1;
      if ((ARBITRABLE_SLICE_STATUSES as readonly string[]).includes(slice.status)) {
        bucket.allocated += slice.allocatedMbps;
      }
      if (slice.status === 'DEGRADED') bucket.degraded += 1;
      byDepartment.set(slice.departmentId, bucket);
    }

    return departments.map((department) => {
      const bucket = byDepartment.get(department.id) ?? { count: 0, allocated: 0, degraded: 0 };
      return {
        department,
        sliceCount: bucket.count,
        allocatedMbps: bucket.allocated,
        degradedSliceCount: bucket.degraded,
        effectiveDegradationCeiling: effectiveDegradationCeiling(department),
      };
    });
  }
}

/** Minimal shape of a slice needed for department roll-ups. */
interface SliceProjection extends AuditableEntity {
  departmentId: string;
  allocatedMbps: number;
  status: string;
}

export interface DepartmentSummary {
  department: Department;
  sliceCount: number;
  allocatedMbps: number;
  degradedSliceCount: number;
  effectiveDegradationCeiling: number;
}
