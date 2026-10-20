import { OFFERED_CAPACITY_MBPS } from '@/config/env';
import { AuditAction, HealthState, SliceStatus, type HealthState as HealthStateType, type SliceProfile } from '@/constants/enums';
import type { IClock } from '@/interfaces/clock.port';
import type { IDatastore } from '@/interfaces/repository.port';
import { diffFields } from '@/models/auditLog.model';
import type { Department } from '@/models/department.model';
import {
  PROFILE_TO_SST,
  canTransition,
  deriveSliceCode,
  type CreateSlicePayload,
  type Slice,
  type UpdateSlicePayload,
} from '@/models/slice.model';
import type { DepartmentRepository } from '@/repositories/department.repository';
import type { SliceRepository } from '@/repositories/slice.repository';
import type { ActorContext, Page } from '@/types/common';
import {
  AlreadyExistsError,
  CapacityExceededError,
  InvalidStateTransitionError,
  NotFoundError,
  PolicyViolationError,
} from '@/utils/errors';
import { hashSeed } from '@/utils/random';
import { round } from '@/utils/math';
import { createLogger } from '@/utils/logger';
import type { AuditService } from './audit.service';

const log = createLogger('slice-service');

/**
 * Slice lifecycle and admission control.
 *
 * ADMISSION CONTROL — THE INVARIANT THAT KEEPS ARBITRATION SOLVABLE
 * =================================================================
 * Σ minGuaranteedMbps over arbitrable slices ≤ offered capacity.
 *
 * If that ever fails, the arbitration engine faces a problem with NO feasible solution:
 * every slice is already at its contractual floor and the network is still oversubscribed.
 * There is no correct answer it can produce, only a choice of which contract to breach.
 *
 * Rejecting the slice at creation time is therefore not a nicety — it is what keeps the
 * control loop well-defined. The check runs inside a transaction so two concurrent
 * creations cannot each observe sufficient headroom and both succeed.
 *
 * Note the asymmetry: BASELINE allocations may legitimately oversubscribe the network.
 * That is the normal condition this platform exists to arbitrate. Only the contractual
 * FLOORS must fit.
 */
export class SliceService {
  constructor(
    private readonly slices: SliceRepository,
    private readonly departments: DepartmentRepository,
    private readonly datastore: IDatastore,
    private readonly audit: AuditService,
    private readonly clock: IClock,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Creation                                                            */
  /* ------------------------------------------------------------------ */

  async create(payload: CreateSlicePayload, actor: ActorContext): Promise<Slice> {
    const code = payload.code ?? deriveSliceCode(payload.name);
    if (!code) {
      throw new PolicyViolationError('A slice code could not be derived from the name', {
        name: payload.name,
      });
    }

    const now = this.clock.nowIso();

    const slice = await this.datastore.runTransaction(async (tx) => {
      /* --- reads --- */
      const department = await this.departments.base.findById(payload.departmentId, { tx });
      if (!department) throw new NotFoundError('Department', payload.departmentId);
      if (!department.active) {
        throw new PolicyViolationError(
          `Department '${department.name}' is inactive and cannot receive new slices`,
          { departmentId: department.id },
        );
      }

      const duplicate = await this.slices.findByCode(code, { tx });
      if (duplicate) throw new AlreadyExistsError('Slice', 'code', code);

      const committedFloor = await this.slices.totalGuaranteedMbps({ tx });
      this.assertFloorFits(committedFloor, payload.minGuaranteedMbps, code);

      /* --- writes --- */
      return this.slices.base.create(
        {
          name: payload.name,
          code,
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          departmentId: payload.departmentId,
          // A caller may omit SD; SST defaults from the profile so the S-NSSAI is always
          // well-formed for a downstream 5G core.
          snssai: {
            sst: payload.snssai?.sst ?? PROFILE_TO_SST[payload.profile],
            ...(payload.snssai?.sd ? { sd: payload.snssai.sd } : {}),
          },
          profile: payload.profile,
          baselineAllocatedMbps: payload.baselineAllocatedMbps,
          allocatedMbps: payload.baselineAllocatedMbps,
          minGuaranteedMbps: payload.minGuaranteedMbps,
          maxBurstMbps: payload.maxBurstMbps,
          slaTargets: payload.slaTargets,
          status: SliceStatus.ACTIVE,
          activatedAt: now,
          health: HealthState.UNKNOWN,
          healthScore: 100,
          degradationHistory: {
            totalEvents: 0,
            cumulativeDegradedSeconds: 0,
            burdenScore: 0,
            recentEvents: [],
          },
          ...(payload.site !== undefined ? { site: payload.site } : {}),
          endpoints: payload.endpoints ?? [],
          tags: payload.tags ?? [],
          // Deterministic per-slice seed, so synthetic telemetry reproduces the same
          // traffic pattern across restarts.
          telemetrySeed: hashSeed(code),
        },
        { tx, actor },
      );
    }, `slice.create:${code}`);

    await this.audit.record({
      action: AuditAction.SLICE_CREATED,
      actor,
      summary:
        `Slice '${slice.name}' created for department ${slice.departmentId} ` +
        `(${slice.baselineAllocatedMbps} kbps baseline, ${slice.minGuaranteedMbps} kbps guaranteed)`,
      target: { type: 'Slice', id: slice.id, name: slice.name, departmentId: slice.departmentId },
      changes: diffFields({}, payload as Record<string, unknown>),
    });

    log.info({ sliceId: slice.id, code, departmentId: slice.departmentId }, 'slice created');
    return slice;
  }

  private assertFloorFits(committedFloor: number, additionalFloor: number, code: string): void {
    const projected = committedFloor + additionalFloor;
    if (projected <= OFFERED_CAPACITY_MBPS) return;

    throw new CapacityExceededError(
      `Admitting slice '${code}' would commit ${round(projected)} kbps of guaranteed minimums ` +
        `against ${OFFERED_CAPACITY_MBPS} kbps of offered capacity. Arbitration would have no ` +
        `feasible solution: every slice would already be at its contractual floor while the ` +
        `network remained oversubscribed.`,
      {
        committedFloorMbps: round(committedFloor),
        requestedFloorMbps: round(additionalFloor),
        projectedFloorMbps: round(projected),
        offeredCapacityMbps: OFFERED_CAPACITY_MBPS,
        availableFloorMbps: round(Math.max(0, OFFERED_CAPACITY_MBPS - committedFloor)),
      },
    );
  }

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  async getById(id: string): Promise<Slice> {
    return this.slices.base.getById(id);
  }

  async list(
    criteria: {
      departmentId?: string;
      status?: SliceStatus;
      profile?: SliceProfile;
      health?: HealthStateType;
    },
    page: { limit: number; cursor?: string },
  ): Promise<Page<Slice>> {
    return this.slices.search(criteria, page);
  }

  async listAll(): Promise<Slice[]> {
    return this.slices.listAll();
  }

  async listArbitrable(): Promise<Slice[]> {
    return this.slices.listArbitrable();
  }

  /** Slices joined with their departments, for the dashboard and topology views. */
  async listEnriched(): Promise<{ slice: Slice; department: Department | null }[]> {
    const slices = await this.slices.listAll();
    const departments = await this.departments.mapByIds(slices.map((s) => s.departmentId));
    return slices.map((slice) => ({
      slice,
      department: departments.get(slice.departmentId) ?? null,
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Update                                                              */
  /* ------------------------------------------------------------------ */

  async update(id: string, payload: UpdateSlicePayload, actor: ActorContext): Promise<Slice> {
    const updated = await this.datastore.runTransaction(async (tx) => {
      /* --- reads --- */
      const current = await this.slices.base.getById(id, { tx });

      if (current.status === SliceStatus.TERMINATED) {
        throw new InvalidStateTransitionError('Slice', SliceStatus.TERMINATED, 'updated');
      }

      if (payload.departmentId && payload.departmentId !== current.departmentId) {
        const department = await this.departments.base.findById(payload.departmentId, { tx });
        if (!department) throw new NotFoundError('Department', payload.departmentId);
        if (!department.active) {
          throw new PolicyViolationError(
            `Department '${department.name}' is inactive and cannot receive slices`,
            { departmentId: department.id },
          );
        }
      }

      // Re-check the ordering rule against the MERGED entity: a patch touching only
      // `minGuaranteedMbps` must still be validated against the existing baseline.
      const merged = {
        minGuaranteedMbps: payload.minGuaranteedMbps ?? current.minGuaranteedMbps,
        baselineAllocatedMbps: payload.baselineAllocatedMbps ?? current.baselineAllocatedMbps,
        maxBurstMbps: payload.maxBurstMbps ?? current.maxBurstMbps,
      };
      if (merged.minGuaranteedMbps > merged.baselineAllocatedMbps) {
        throw new PolicyViolationError(
          `Guaranteed minimum (${merged.minGuaranteedMbps} kbps) cannot exceed the baseline ` +
            `allocation (${merged.baselineAllocatedMbps} kbps)`,
          { sliceId: id, ...merged },
        );
      }
      if (merged.baselineAllocatedMbps > merged.maxBurstMbps) {
        throw new PolicyViolationError(
          `Burst ceiling (${merged.maxBurstMbps} kbps) cannot be below the baseline allocation ` +
            `(${merged.baselineAllocatedMbps} kbps)`,
          { sliceId: id, ...merged },
        );
      }

      // Raising the guaranteed floor consumes fleet-wide headroom and must be re-admitted.
      if (payload.minGuaranteedMbps !== undefined && payload.minGuaranteedMbps > current.minGuaranteedMbps) {
        const committedFloor = await this.slices.totalGuaranteedMbps({ tx });
        this.assertFloorFits(
          committedFloor - current.minGuaranteedMbps,
          payload.minGuaranteedMbps,
          current.code,
        );
      }

      /* --- writes --- */
      // Raising the baseline while the slice is degraded must not silently undo the
      // degradation: `allocatedMbps` is only re-derived when the slice is at baseline.
      const isAtBaseline = current.allocatedMbps >= current.baselineAllocatedMbps;
      const nextAllocated =
        payload.baselineAllocatedMbps !== undefined && isAtBaseline
          ? payload.baselineAllocatedMbps
          : current.allocatedMbps;

      return this.slices.base.applyUpdate(
        current,
        { ...payload, allocatedMbps: nextAllocated },
        { tx, actor, expectedVersion: current.version },
      );
    }, `slice.update:${id}`);

    await this.audit.record({
      action: AuditAction.SLICE_UPDATED,
      actor,
      summary: `Slice '${updated.name}' updated`,
      target: {
        type: 'Slice',
        id,
        name: updated.name,
        departmentId: updated.departmentId,
      },
      changes: diffFields({}, payload as Record<string, unknown>),
    });

    return updated;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle transitions                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Pause a slice — it stops consuming capacity and leaves the arbitration pool.
   *
   * Pausing a DEGRADED slice clears its active degradation: it is no longer consuming
   * capacity, so holding a degradation record against it would corrupt the recovery
   * scheduler and inflate its fairness burden for time it was not actually degraded.
   */
  async pause(id: string, reason: string, actor: ActorContext): Promise<Slice> {
    const paused = await this.transition(id, SliceStatus.PAUSED, actor, (current) => ({
      pausedAt: this.clock.nowIso(),
      pausedReason: reason,
      activeDegradation: undefined,
      allocatedMbps: current.baselineAllocatedMbps,
      health: HealthState.UNKNOWN,
    }));

    await this.audit.record({
      action: AuditAction.SLICE_PAUSED,
      actor,
      summary: `Slice '${paused.name}' paused: ${reason}`,
      target: { type: 'Slice', id, name: paused.name, departmentId: paused.departmentId },
      metadata: { reason, releasedMbps: paused.baselineAllocatedMbps },
    });

    log.info({ sliceId: id, reason }, 'slice paused');
    return paused;
  }

  /**
   * Resume a paused slice.
   *
   * Re-admission is deliberate: the network may have changed while the slice was paused,
   * and restoring it must not push committed floors past capacity. Resuming can therefore
   * legitimately fail, which is better than silently creating an unsolvable state.
   */
  async resume(id: string, actor: ActorContext): Promise<Slice> {
    const resumed = await this.datastore.runTransaction(async (tx) => {
      /* --- reads --- */
      const current = await this.slices.base.getById(id, { tx });

      if (!canTransition(current.status, SliceStatus.ACTIVE)) {
        throw new InvalidStateTransitionError('Slice', current.status, SliceStatus.ACTIVE);
      }

      const committedFloor = await this.slices.totalGuaranteedMbps({ tx });
      this.assertFloorFits(committedFloor, current.minGuaranteedMbps, current.code);

      /* --- writes --- */
      return this.slices.base.applyUpdate(
        current,
        {
          status: SliceStatus.ACTIVE,
          allocatedMbps: current.baselineAllocatedMbps,
          activatedAt: this.clock.nowIso(),
          pausedAt: undefined,
          pausedReason: undefined,
          health: HealthState.UNKNOWN,
        },
        { tx, actor, expectedVersion: current.version },
      );
    }, `slice.resume:${id}`);

    await this.audit.record({
      action: AuditAction.SLICE_RESUMED,
      actor,
      summary: `Slice '${resumed.name}' resumed at ${resumed.allocatedMbps} kbps`,
      target: { type: 'Slice', id, name: resumed.name, departmentId: resumed.departmentId },
    });

    log.info({ sliceId: id }, 'slice resumed');
    return resumed;
  }

  /**
   * Delete a slice.
   *
   * Terminates rather than hard-deleting when the slice has arbitration history: audit
   * records reference it by id, and a dangling reference would make a past decision
   * unreadable. A slice that was never degraded carries no such history and is removed.
   */
  async delete(id: string, actor: ActorContext): Promise<{ deleted: boolean }> {
    const outcome = await this.datastore.runTransaction(async (tx) => {
      const current = await this.slices.base.getById(id, { tx });
      const hasHistory = current.degradationHistory.totalEvents > 0;

      if (hasHistory) {
        const terminated = await this.slices.base.applyUpdate(
          current,
          {
            status: SliceStatus.TERMINATED,
            allocatedMbps: 0,
            activeDegradation: undefined,
            health: HealthState.UNKNOWN,
          },
          { tx, actor, expectedVersion: current.version },
        );
        return { slice: terminated, deleted: false };
      }

      await this.slices.base.applyDelete(current, { tx, expectedVersion: current.version });
      return { slice: current, deleted: true };
    }, `slice.delete:${id}`);

    await this.audit.record({
      action: AuditAction.SLICE_DELETED,
      actor,
      summary: outcome.deleted
        ? `Slice '${outcome.slice.name}' deleted`
        : `Slice '${outcome.slice.name}' terminated (retained: it has arbitration history)`,
      target: {
        type: 'Slice',
        id,
        name: outcome.slice.name,
        departmentId: outcome.slice.departmentId,
      },
      metadata: { hardDeleted: outcome.deleted },
    });

    log.info({ sliceId: id, hardDeleted: outcome.deleted }, 'slice removed');
    return { deleted: outcome.deleted };
  }

  /**
   * Generic guarded transition. Every status change goes through here, so the state
   * machine in `slice.model.ts` is enforced in exactly one place.
   */
  private async transition(
    id: string,
    to: SliceStatus,
    actor: ActorContext,
    patch: (current: Slice) => Partial<Slice>,
  ): Promise<Slice> {
    return this.datastore.runTransaction(async (tx) => {
      const current = await this.slices.base.getById(id, { tx });

      if (current.status === to) {
        throw new InvalidStateTransitionError('Slice', current.status, to);
      }
      if (!canTransition(current.status, to)) {
        throw new InvalidStateTransitionError('Slice', current.status, to);
      }

      return this.slices.base.applyUpdate(
        current,
        { ...patch(current), status: to },
        { tx, actor, expectedVersion: current.version },
      );
    }, `slice.transition:${id}:${to}`);
  }

  /* ------------------------------------------------------------------ */
  /* Capacity reporting                                                  */
  /* ------------------------------------------------------------------ */

  /** Committed-floor headroom, surfaced on the Slices screen before a create. */
  async admissionHeadroom(): Promise<{
    offeredCapacityMbps: number;
    committedFloorMbps: number;
    availableFloorMbps: number;
    committedBaselineMbps: number;
    baselineOversubscriptionRatio: number;
  }> {
    const arbitrable = await this.slices.listArbitrable();
    const committedFloor = arbitrable.reduce((sum, s) => sum + s.minGuaranteedMbps, 0);
    const committedBaseline = arbitrable.reduce((sum, s) => sum + s.baselineAllocatedMbps, 0);

    return {
      offeredCapacityMbps: OFFERED_CAPACITY_MBPS,
      committedFloorMbps: round(committedFloor),
      availableFloorMbps: round(Math.max(0, OFFERED_CAPACITY_MBPS - committedFloor)),
      committedBaselineMbps: round(committedBaseline),
      // > 1 is normal and expected — it is the condition arbitration exists to manage.
      baselineOversubscriptionRatio: round(committedBaseline / OFFERED_CAPACITY_MBPS, 4),
    };
  }
}
