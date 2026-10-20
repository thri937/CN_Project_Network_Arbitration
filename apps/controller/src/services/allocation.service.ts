import {
  ArbitrationOutcome,
  ArbitrationTrigger,
  AuditAction,
  NotificationSeverity,
  RecoveryStatus,
  SliceDisposition,
  SliceStatus,
  UserRole,
} from '@/constants/enums';
import type { IClock } from '@/interfaces/clock.port';
import type { IDatastore } from '@/interfaces/repository.port';
import type { AllocationCommand, INetworkTelemetryPort } from '@/interfaces/telemetry.port';
import { ArbitrationVerdict, type ArbitrationPlan } from '@/domain/arbitration/types';
import type {
  ArbitrationDecision,
  DecisionAllocation,
} from '@/models/arbitrationDecision.model';
import type { ContentionEvent } from '@/models/contention.model';
import type { ResolvedPolicy } from '@/models/policy.model';
import type { Slice } from '@/models/slice.model';
import type { ArbitrationRepository } from '@/repositories/arbitration.repository';
import type { SliceRepository } from '@/repositories/slice.repository';
import { SYSTEM_ACTOR, type ActorContext } from '@/types/common';
import { round } from '@/utils/math';
import { createLogger } from '@/utils/logger';
import type { AuditService } from './audit.service';
import type { NotificationService } from './notification.service';

const log = createLogger('allocation-manager');

/**
 * RESOURCE ALLOCATION MANAGER
 * ===========================
 * Turns an arbitration plan into an actual change to the network.
 *
 * THE CENTRAL DIFFICULTY: TWO SYSTEMS, ONE OF THEM NOT TRANSACTIONAL
 * ------------------------------------------------------------------
 * A plan must be applied to BOTH the datastore (our model of the world) and the network
 * itself (the world). The datastore is transactional. The network is not — you cannot roll
 * back a bandwidth limit a PCF has already accepted.
 *
 * So application is explicitly two-phase:
 *
 *   PHASE 1 — datastore transaction
 *     Slices, the decision record and the audit entry commit together, or none do. After
 *     this phase there is a durable, auditable record of INTENT even if the process dies.
 *
 *   PHASE 2 — network enforcement
 *     Commands are pushed through `INetworkTelemetryPort`. Per-slice results are recorded.
 *     Any slice the network REFUSED is reconciled back to its previous allocation in our
 *     model, and the discrepancy is recorded on the decision.
 *
 * Reconciliation is the part that is easy to omit and expensive to omit. If the platform
 * believes a slice is limited to 400 Mbps while the network still permits 800, then every
 * subsequent capacity measurement, contention detection and arbitration decision is
 * computed against a fiction. Recording the divergence — and correcting our model to match
 * reality — is what keeps the control loop honest.
 *
 * Ordering within Phase 1 obeys the datastore's reads-before-writes contract: every slice
 * is read first, then every write is issued through `applyUpdate`.
 */
export interface ApplyContext {
  trigger: ArbitrationTrigger;
  actor: ActorContext;
  contentionEvent: ContentionEvent;
  policy: ResolvedPolicy;
}

export class AllocationService {
  constructor(
    private readonly slices: SliceRepository,
    private readonly decisions: ArbitrationRepository,
    private readonly datastore: IDatastore,
    private readonly network: INetworkTelemetryPort,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: IClock,
  ) {}

  async apply(plan: ArbitrationPlan, context: ApplyContext): Promise<ArbitrationDecision> {
    const nowMs = this.clock.now();
    const degradedAllocations = plan.allocations.filter(
      (a) => a.disposition === SliceDisposition.DEGRADED && a.reductionMbps > 1e-6,
    );

    /* ================= PHASE 1 — datastore transaction ================ */

    const { decision, slicesBefore } = await this.datastore.runTransaction(async (tx) => {
      /* --- reads (all of them, before any write) --- */
      const targetIds = degradedAllocations.map((a) => a.sliceId);
      const loaded = await this.slices.base.findByIds(targetIds, { tx });

      const byId = new Map<string, Slice>();
      for (const slice of loaded) if (slice) byId.set(slice.id, slice);

      /* --- writes --- */
      for (const allocation of degradedAllocations) {
        const slice = byId.get(allocation.sliceId);
        if (!slice) {
          log.warn({ sliceId: allocation.sliceId }, 'slice vanished before the plan could be applied');
          continue;
        }

        const expiresAtMs = nowMs + allocation.durationSeconds * 1000;

        await this.slices.base.applyUpdate(
          slice,
          {
            allocatedMbps: allocation.newAllocationMbps,
            status: SliceStatus.DEGRADED,
            activeDegradation: {
              decisionId: 'pending', // replaced below once the decision id exists
              contentionId: context.contentionEvent.id,
              appliedAt: new Date(nowMs).toISOString(),
              expiresAt: new Date(expiresAtMs).toISOString(),
              percent: allocation.degradationPercent,
              reducedMbps: allocation.reductionMbps,
              reason: allocation.reason.slice(0, 2000),
              businessScore: allocation.businessScore,
            },
            degradationHistory: this.appendHistory(slice, allocation, nowMs),
          },
          { tx, actor: context.actor, expectedVersion: slice.version },
        );
      }

      const record = await this.decisions.base.create(
        this.buildDecision(plan, context, nowMs, degradedAllocations.length > 0),
        { tx, actor: context.actor },
      );

      // Audit is enlisted in the SAME transaction. A degraded slice with no corresponding
      // audit record is precisely the failure this platform exists to prevent, so the two
      // commit together or not at all.
      await this.audit.recordInTransaction(
        {
          action: AuditAction.ARBITRATION_EXECUTED,
          actor: context.actor,
          summary:
            `Arbitration ${record.id}: ${plan.verdict}, freed ` +
            `${round(plan.achievedReductionMbps, 1)} Mbps across ${degradedAllocations.length} slice(s)`,
          target: { type: 'ArbitrationDecision', id: record.id },
          metadata: {
            contentionId: context.contentionEvent.id,
            verdict: plan.verdict,
            confidence: plan.confidence,
            totalHarm: plan.totalHarm,
            degradedSliceIds: plan.degradedSliceIds,
          },
        },
        tx,
      );

      return { decision: record, slicesBefore: byId };
    }, `allocation.apply:${plan.contentionId}`);

    /* ---- Backfill the decision id onto each degraded slice ------------ */
    // Cannot be done inside the transaction: the id does not exist until the create above,
    // and re-reading the slices to patch them would violate reads-before-writes.
    await this.stampDecisionId(degradedAllocations, decision.id);

    /* ================= PHASE 2 — network enforcement ================== */

    const commands: AllocationCommand[] = degradedAllocations
      .map((allocation) => {
        const slice = slicesBefore.get(allocation.sliceId);
        if (!slice) return null;
        return {
          sliceId: allocation.sliceId,
          code: allocation.sliceCode,
          snssai: slice.snssai,
          targetMbps: allocation.newAllocationMbps,
          previousMbps: allocation.previousAllocationMbps,
          decisionId: decision.id,
          reason: allocation.reason.slice(0, 500),
        } satisfies AllocationCommand;
      })
      .filter((command): command is AllocationCommand => command !== null);

    const results = commands.length > 0 ? await this.network.applyAllocation(commands) : [];
    const resultById = new Map(results.map((r) => [r.sliceId, r]));

    const failures = results.filter((r) => !r.applied);

    /* ---- Reconcile ---------------------------------------------------- */
    if (failures.length > 0) {
      await this.reconcileFailures(failures, slicesBefore, decision.id, context.actor);
    }

    /* ---- Record enforcement outcome on the decision -------------------- */
    const finalised = await this.decisions.base.update(decision.id, {
      allocations: decision.allocations.map((allocation) => {
        const result = resultById.get(allocation.sliceId);
        if (!result) return allocation;
        return {
          ...allocation,
          applied: result.applied,
          effectiveMbps: result.effectiveMbps,
          ...(result.error ? { applicationError: result.error.slice(0, 1000) } : {}),
        };
      }),
      outcome: this.deriveOutcome(plan, failures.length, degradedAllocations.length),
    });

    if (failures.length > 0) {
      await this.notifications.create({
        severity: NotificationSeverity.ERROR,
        title: 'Network refused part of an arbitration plan',
        body:
          `${failures.length} of ${commands.length} bandwidth changes could not be enforced by ` +
          `provider '${this.network.name}'. Those slices have been reconciled back to their previous ` +
          `allocations, so the platform's view matches the network. The contention is NOT fully mitigated.`,
        broadcast: true,
        minimumRole: UserRole.MANAGER,
        subject: { type: 'ArbitrationDecision', id: decision.id },
        link: `/arbitration/${decision.id}`,
        metadata: { failedSliceIds: failures.map((f) => f.sliceId) },
      });
    }

    log.info(
      {
        decisionId: decision.id,
        applied: commands.length - failures.length,
        failed: failures.length,
        freedMbps: plan.achievedReductionMbps,
      },
      'allocation applied',
    );

    return finalised;
  }

  /* ------------------------------------------------------------------ */

  private async stampDecisionId(
    allocations: ArbitrationPlan['allocations'],
    decisionId: string,
  ): Promise<void> {
    for (const allocation of allocations) {
      try {
        const slice = await this.slices.base.findById(allocation.sliceId);
        if (!slice?.activeDegradation) continue;
        await this.slices.base.applyUpdate(slice, {
          activeDegradation: { ...slice.activeDegradation, decisionId },
        });
      } catch (error) {
        log.warn({ sliceId: allocation.sliceId, err: error }, 'failed to stamp decision id');
      }
    }
  }

  /**
   * Restore slices the network refused to degrade.
   *
   * Without this the platform's model and the network diverge permanently, and every later
   * decision is computed against a fiction.
   */
  private async reconcileFailures(
    failures: { sliceId: string; effectiveMbps: number; error?: string }[],
    slicesBefore: Map<string, Slice>,
    decisionId: string,
    actor: ActorContext,
  ): Promise<void> {
    for (const failure of failures) {
      const previous = slicesBefore.get(failure.sliceId);
      if (!previous) continue;

      try {
        const current = await this.slices.base.findById(failure.sliceId);
        if (!current) continue;

        await this.slices.base.applyUpdate(current, {
          // Trust the NETWORK's reported value over our intent. It is the authority on what
          // is actually enforced.
          allocatedMbps: failure.effectiveMbps || previous.allocatedMbps,
          status: SliceStatus.ACTIVE,
          activeDegradation: undefined,
        });

        await this.audit.record({
          action: AuditAction.ALLOCATION_ROLLED_BACK,
          actor,
          summary:
            `Slice ${previous.name} reconciled to ${failure.effectiveMbps || previous.allocatedMbps} Mbps: ` +
            `the network refused the change (${failure.error ?? 'unknown error'})`,
          target: { type: 'Slice', id: failure.sliceId, name: previous.name },
          metadata: { decisionId, error: failure.error },
        });

        log.error(
          { sliceId: failure.sliceId, decisionId, error: failure.error },
          'enforcement failed; slice reconciled to the network-reported allocation',
        );
      } catch (error) {
        log.error({ sliceId: failure.sliceId, err: error }, 'reconciliation itself failed');
      }
    }
  }

  private deriveOutcome(
    plan: ArbitrationPlan,
    failureCount: number,
    attemptedCount: number,
  ): ArbitrationOutcome {
    if (plan.verdict === ArbitrationVerdict.INFEASIBLE) return ArbitrationOutcome.ESCALATED;
    if (failureCount > 0 && failureCount === attemptedCount) return ArbitrationOutcome.ABORTED;
    if (failureCount > 0 || plan.verdict === ArbitrationVerdict.PARTIAL) {
      return ArbitrationOutcome.PARTIAL;
    }
    return ArbitrationOutcome.RESOLVED;
  }

  /**
   * Append to the slice's rolling degradation burden.
   *
   * `burdenScore` combines DEPTH and DURATION into one number — 50 % for 10 minutes and
   * 25 % for 20 minutes represent the same burden, which is the intuitively fair comparison
   * and the one the fairness multiplier needs.
   */
  private appendHistory(
    slice: Slice,
    allocation: ArbitrationPlan['allocations'][number],
    nowMs: number,
  ): Slice['degradationHistory'] {
    const history = slice.degradationHistory;
    const depthFraction = allocation.degradationPercent / 100;

    return {
      totalEvents: history.totalEvents + 1,
      cumulativeDegradedSeconds: history.cumulativeDegradedSeconds,
      burdenScore: round(history.burdenScore + depthFraction * allocation.durationSeconds, 4),
      lastDegradedAt: new Date(nowMs).toISOString(),
      ...(history.lastRecoveredAt ? { lastRecoveredAt: history.lastRecoveredAt } : {}),
      recentEvents: [
        ...history.recentEvents,
        {
          at: new Date(nowMs).toISOString(),
          atMs: nowMs,
          percent: allocation.degradationPercent,
          durationSeconds: allocation.durationSeconds,
          decisionId: 'pending',
        },
      ].slice(-200),
    };
  }

  private buildDecision(
    plan: ArbitrationPlan,
    context: ApplyContext,
    nowMs: number,
    hasDegradations: boolean,
  ): Omit<ArbitrationDecision, 'id' | 'createdAt' | 'updatedAt' | 'version'> {
    const allocations: DecisionAllocation[] = plan.allocations.map((allocation) => ({
      sliceId: allocation.sliceId,
      sliceCode: allocation.sliceCode,
      sliceName: allocation.sliceName,
      departmentId: allocation.departmentId,
      departmentName: allocation.departmentName,
      disposition: allocation.disposition,
      demandMbps: allocation.demandMbps,
      previousAllocationMbps: allocation.previousAllocationMbps,
      newAllocationMbps: allocation.newAllocationMbps,
      reductionMbps: allocation.reductionMbps,
      degradationPercent: allocation.degradationPercent,
      businessScore: allocation.businessScore,
      harmIncurred: allocation.harmIncurred,
      marginalHarmAtStop: allocation.marginalHarmAtStop,
      durationSeconds: allocation.durationSeconds,
      ...(allocation.durationSeconds > 0
        ? {
            expiresAt: new Date(allocation.expiresAtMs).toISOString(),
            expiresAtMs: allocation.expiresAtMs,
          }
        : {}),
      reason: allocation.reason,
      factors: allocation.factors,
      applied: false,
      recoveryStatus:
        allocation.disposition === SliceDisposition.DEGRADED
          ? RecoveryStatus.PENDING
          : RecoveryStatus.NOT_APPLICABLE,
    }));

    const degradedExpiries = plan.allocations
      .filter((a) => a.disposition === SliceDisposition.DEGRADED && a.durationSeconds > 0)
      .map((a) => a.expiresAtMs);

    return {
      contentionId: plan.contentionId,
      trigger: context.trigger,
      outcome: ArbitrationOutcome.RESOLVED, // refined in phase 2
      verdict: plan.verdict,
      decidedAt: new Date(nowMs).toISOString(),
      decidedAtMs: nowMs,
      offeredCapacityMbps: context.contentionEvent.offeredCapacityMbps,
      totalDemandMbps: context.contentionEvent.currentDemandRatio * context.contentionEvent.offeredCapacityMbps,
      requiredReductionMbps: plan.requiredReductionMbps,
      achievedReductionMbps: plan.achievedReductionMbps,
      shortfallMbps: plan.shortfallMbps,
      allocations,
      degradedSliceIds: plan.degradedSliceIds,
      protectedSliceIds: plan.protectedSliceIds,
      exemptSliceIds: plan.exemptSliceIds,
      totalHarm: plan.totalHarm,
      confidence: plan.confidence,
      confidenceBreakdown: plan.confidenceBreakdown as unknown as Record<string, number>,
      alternatives: plan.alternatives,
      rationale: plan.rationale,
      ...(plan.escalationReason ? { escalationReason: plan.escalationReason } : {}),
      policySnapshot: {
        policyId: context.policy.policyId,
        policyName: context.policy.policyName,
        revision: context.policy.revision,
        weights: context.policy.weights as unknown as Record<string, number>,
        arbitration: context.policy.arbitration as unknown as Record<string, number | boolean>,
      },
      administrator: context.actor.userId,
      ...(context.actor.email ? { administratorEmail: context.actor.email } : {}),
      recoveryStatus: hasDegradations ? RecoveryStatus.PENDING : RecoveryStatus.NOT_APPLICABLE,
      ...(degradedExpiries.length > 0 ? { nextRecoveryAtMs: Math.min(...degradedExpiries) } : {}),
      diagnostics: plan.diagnostics as unknown as Record<string, number | boolean>,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Recovery                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Restore slices whose degradation has expired.
   *
   * Run by the recovery scheduler. Idempotent: a slice already at baseline is skipped, and
   * `applyAllocation` is required by the port to tolerate a repeated target.
   */
  async recoverExpired(): Promise<{ decisionsProcessed: number; slicesRestored: number }> {
    const nowMs = this.clock.now();
    const pending = await this.decisions.findAwaitingRecovery(nowMs);

    let slicesRestored = 0;

    for (const decision of pending) {
      const restored = await this.restoreDecision(
        decision,
        SYSTEM_ACTOR,
        'degradation window expired',
        { onlyExpired: true },
      );
      slicesRestored += restored;
    }

    return { decisionsProcessed: pending.length, slicesRestored };
  }

  /**
   * Restore the slices degraded by a decision.
   * @returns the number of slices actually restored.
   */
  async restoreDecision(
    decision: ArbitrationDecision,
    actor: ActorContext,
    reason: string,
    options: { onlyExpired?: boolean } = {},
  ): Promise<number> {
    const nowMs = this.clock.now();

    const targets = decision.allocations.filter(
      (allocation) =>
        allocation.disposition === SliceDisposition.DEGRADED &&
        allocation.recoveryStatus !== RecoveryStatus.RECOVERED &&
        (!options.onlyExpired || (allocation.expiresAtMs ?? 0) <= nowMs),
    );

    if (targets.length === 0) return 0;

    const commands: AllocationCommand[] = [];
    let restored = 0;

    for (const allocation of targets) {
      try {
        const slice = await this.slices.base.findById(allocation.sliceId);
        // A slice deleted or paused since the decision has nothing to restore.
        if (!slice || slice.status === SliceStatus.TERMINATED || slice.status === SliceStatus.PAUSED) {
          continue;
        }

        const degradedSeconds = allocation.expiresAtMs
          ? Math.max(0, (Math.min(nowMs, allocation.expiresAtMs) - (allocation.expiresAtMs - allocation.durationSeconds * 1000)) / 1000)
          : allocation.durationSeconds;

        await this.slices.base.applyUpdate(slice, {
          allocatedMbps: slice.baselineAllocatedMbps,
          status: SliceStatus.ACTIVE,
          activeDegradation: undefined,
          degradationHistory: {
            ...slice.degradationHistory,
            cumulativeDegradedSeconds: round(
              slice.degradationHistory.cumulativeDegradedSeconds + degradedSeconds,
              2,
            ),
            lastRecoveredAt: new Date(nowMs).toISOString(),
          },
        });

        commands.push({
          sliceId: slice.id,
          code: slice.code,
          snssai: slice.snssai,
          targetMbps: slice.baselineAllocatedMbps,
          previousMbps: slice.allocatedMbps,
          decisionId: decision.id,
          reason: `Recovery: ${reason}`,
        });

        restored += 1;
      } catch (error) {
        log.error({ sliceId: allocation.sliceId, err: error }, 'slice recovery failed');
      }
    }

    if (commands.length > 0) {
      await this.network.applyAllocation(commands).catch((error: unknown) => {
        log.error({ err: error, decisionId: decision.id }, 'network restore failed');
        return [];
      });
    }

    /* ---- Update the decision's recovery state ------------------------- */
    const recoveredIds = new Set(commands.map((c) => c.sliceId));
    const updatedAllocations = decision.allocations.map((allocation) =>
      recoveredIds.has(allocation.sliceId)
        ? {
            ...allocation,
            recoveryStatus: RecoveryStatus.RECOVERED,
            recoveredAt: new Date(nowMs).toISOString(),
          }
        : allocation,
    );

    const outstanding = updatedAllocations.filter(
      (a) =>
        a.disposition === SliceDisposition.DEGRADED && a.recoveryStatus !== RecoveryStatus.RECOVERED,
    );

    const nextExpiry = outstanding
      .map((a) => a.expiresAtMs ?? Number.POSITIVE_INFINITY)
      .filter((ms) => Number.isFinite(ms));

    await this.decisions.base.update(decision.id, {
      allocations: updatedAllocations,
      recoveryStatus: outstanding.length === 0 ? RecoveryStatus.RECOVERED : RecoveryStatus.IN_PROGRESS,
      ...(outstanding.length === 0 ? { fullyRecoveredAt: new Date(nowMs).toISOString() } : {}),
      ...(nextExpiry.length > 0 ? { nextRecoveryAtMs: Math.min(...nextExpiry) } : {}),
    });

    if (restored > 0) {
      await this.audit.record({
        action: AuditAction.RECOVERY_COMPLETED,
        actor,
        summary: `Restored ${restored} slice(s) to baseline allocation (${reason})`,
        target: { type: 'ArbitrationDecision', id: decision.id },
        metadata: { restoredSliceIds: [...recoveredIds], reason },
      });

      await this.notifications.create({
        severity: NotificationSeverity.SUCCESS,
        title: `${restored} slice(s) restored to full bandwidth`,
        body: `Degradation from decision ${decision.id} has been lifted (${reason}).`,
        broadcast: true,
        minimumRole: UserRole.VIEWER,
        subject: { type: 'ArbitrationDecision', id: decision.id },
        link: `/arbitration/${decision.id}`,
      });

      log.info({ decisionId: decision.id, restored, reason }, 'slices recovered');
    }

    return restored;
  }
}
