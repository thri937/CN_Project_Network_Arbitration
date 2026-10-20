import {
  ArbitrationOutcome,
  ArbitrationTrigger,
  AuditAction,
  NotificationSeverity,
  RecoveryStatus,
  SliceDisposition,
  UserRole,
} from '@/constants/enums';
import type { IClock } from '@/interfaces/clock.port';
import { arbitrate } from '@/domain/arbitration/engine';
import {
  ArbitrationVerdict,
  type ArbitrationCandidate,
  type ArbitrationPlan,
} from '@/domain/arbitration/types';
import { computeBusinessPriority, type BusinessProfile } from '@/domain/policyEngine';
import type { ArbitrationDecision } from '@/models/arbitrationDecision.model';
import type { ContentionEvent } from '@/models/contention.model';
import { effectiveDegradationCeiling, type Department } from '@/models/department.model';
import type { ResolvedPolicy } from '@/models/policy.model';
import type { Slice } from '@/models/slice.model';
import type { LiveSliceState } from '@/models/telemetry.model';
import type { ArbitrationRepository } from '@/repositories/arbitration.repository';
import type { DepartmentRepository } from '@/repositories/department.repository';
import type { SliceRepository } from '@/repositories/slice.repository';
import { SYSTEM_ACTOR, type ActorContext, type Page } from '@/types/common';
import { ArbitrationInfeasibleError, ConflictError } from '@/utils/errors';
import { ErrorCode } from '@/constants/errorCodes';
import { round } from '@/utils/math';
import { createLogger } from '@/utils/logger';
import type { AllocationService } from './allocation.service';
import type { AuditService } from './audit.service';
import type { ContentionService } from './contention.service';
import type { NotificationService } from './notification.service';
import type { PolicyService } from './policy.service';
import type { TelemetryService } from './telemetry.service';

const log = createLogger('arbitration');

/**
 * Arbitration orchestration.
 *
 * The pure engine in `domain/arbitration/` decides. This service does everything around
 * that decision: assemble its inputs, persist the record, apply the plan, notify, audit.
 *
 * THE SPLIT MATTERS. Keeping the engine free of I/O is what makes it exhaustively testable
 * and what makes a recorded decision re-executable. Keeping the orchestration out of the
 * engine is what stops "compute a plan" and "change the network" from becoming one
 * untestable operation.
 */
export class ArbitrationService {
  constructor(
    private readonly slices: SliceRepository,
    private readonly departments: DepartmentRepository,
    private readonly decisions: ArbitrationRepository,
    private readonly policies: PolicyService,
    private readonly telemetry: TelemetryService,
    private readonly contention: ContentionService,
    private readonly allocation: AllocationService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: IClock,
  ) {}

  /**
   * Run arbitration for an open contention.
   *
   * Guards, in order — each exists because skipping it causes a specific failure:
   *   1. cooldown / in-flight gate      → prevents compounding degradations
   *   2. telemetry freshness            → prevents acting on a frozen view of the network
   *   3. mark ARBITRATING               → prevents a concurrent tick starting a second pass
   */
  async run(
    contentionEvent: ContentionEvent,
    options: { trigger?: ArbitrationTrigger; actor?: ActorContext; dryRun?: boolean } = {},
  ): Promise<{ decision: ArbitrationDecision | null; plan: ArbitrationPlan }> {
    const trigger = options.trigger ?? ArbitrationTrigger.AUTOMATIC;
    const actor = options.actor ?? SYSTEM_ACTOR;
    const dryRun = options.dryRun ?? false;

    if (!dryRun) {
      const gate = this.contention.canArbitrate(contentionEvent);
      if (!gate.allowed) {
        throw new ConflictError(
          `Arbitration is not permitted right now: ${gate.reason}`,
          ErrorCode.CONFLICT,
          { contentionId: contentionEvent.id, ...gate },
        );
      }
    }

    const snapshot = this.telemetry.getSnapshot();
    if (!snapshot || snapshot.slices.length === 0) {
      // Acting on an absent or empty view of the network would mean degrading slices on
      // the basis of no evidence at all.
      throw new ArbitrationInfeasibleError(
        'No telemetry snapshot is available; arbitration cannot proceed without observing the network',
        { contentionId: contentionEvent.id },
      );
    }

    const policy = await this.policies.getActiveResolved();
    const candidates = await this.buildCandidates(snapshot.slices, policy);

    const plan = arbitrate({
      contentionId: contentionEvent.id,
      candidates,
      offeredCapacityMbps: snapshot.offeredCapacityMbps,
      totalDemandMbps: snapshot.totalDemandMbps,
      atMs: this.clock.now(),
      settings: policy.arbitration,
      policyId: policy.policyId,
      policyRevision: policy.revision,
      policyName: policy.policyName,
    });

    log.info(
      {
        contentionId: contentionEvent.id,
        verdict: plan.verdict,
        degraded: plan.degradedSliceIds.length,
        freedMbps: plan.achievedReductionMbps,
        confidence: plan.confidence,
        computeMs: plan.diagnostics.computeMs,
        dryRun,
      },
      'arbitration plan computed',
    );

    if (dryRun) return { decision: null, plan };

    if (plan.verdict === ArbitrationVerdict.NOT_REQUIRED) {
      await this.contention.releaseArbitrating(contentionEvent.id, 'contention cleared before arbitration');
      return { decision: null, plan };
    }

    /* ---- Apply ------------------------------------------------------- */
    await this.contention.markArbitrating(contentionEvent.id);

    try {
      const decision = await this.allocation.apply(plan, {
        trigger,
        actor,
        contentionEvent,
        policy,
      });

      await this.contention.recordArbitration(contentionEvent.id, {
        decisionId: decision.id,
        mitigated: plan.verdict !== ArbitrationVerdict.INFEASIBLE,
        ...(plan.escalationReason ? { unresolvableReason: plan.escalationReason } : {}),
      });

      await this.announce(decision, plan);
      return { decision, plan };
    } catch (error) {
      // Release the lock so the next tick can retry, rather than leaving the contention
      // stuck in ARBITRATING forever.
      await this.contention.releaseArbitrating(
        contentionEvent.id,
        error instanceof Error ? error.message : 'arbitration failed',
      );
      throw error;
    }
  }

  /**
   * Assemble engine inputs from live telemetry plus stored business context.
   *
   * Deliberately reads BOTH: telemetry supplies the runtime facts (demand, stress), the
   * datastore supplies the business facts (criticality, cost, ceilings). Using one without
   * the other would give either a technically-correct decision with no business basis, or a
   * business-correct decision about a network that no longer looks like that.
   */
  private async buildCandidates(
    states: LiveSliceState[],
    policy: ResolvedPolicy,
  ): Promise<ArbitrationCandidate[]> {
    const sliceIds = states.map((s) => s.sliceId);
    const slices = await this.slices.base.findByIds(sliceIds);
    const sliceById = new Map<string, Slice>();
    for (const slice of slices) if (slice) sliceById.set(slice.id, slice);

    const departments = await this.departments.mapByIds(
      [...sliceById.values()].map((s) => s.departmentId),
    );

    const nowMs = this.clock.now();
    const candidates: ArbitrationCandidate[] = [];

    for (const state of states) {
      const slice = sliceById.get(state.sliceId);
      const department = slice ? departments.get(slice.departmentId) : undefined;

      // A slice whose department has vanished cannot be ranked on business grounds, so it
      // is excluded from the candidate set rather than being ranked on a guess. It is
      // logged loudly because it indicates a referential-integrity failure upstream.
      if (!slice || !department) {
        log.error(
          { sliceId: state.sliceId, hasSlice: Boolean(slice), hasDepartment: Boolean(department) },
          'slice excluded from arbitration: missing business context',
        );
        continue;
      }

      const profile: BusinessProfile = {
        departmentId: department.id,
        departmentName: department.name,
        criticality: department.criticality,
        businessImportance: department.businessImportance,
        downtimeCostPerMinute: department.downtimeCostPerMinute,
        recoveryTolerance: department.recoveryTolerance,
        complianceLevel: department.complianceLevel,
        customerImpact: department.customerImpact,
        operationalImportance: department.operationalImportance,
        policyWeightMultiplier: department.policyWeightMultiplier,
      };

      candidates.push({
        sliceId: slice.id,
        sliceCode: slice.code,
        sliceName: slice.name,
        departmentId: department.id,
        departmentName: department.name,
        demandMbps: state.demandMbps,
        allocatedMbps: state.allocatedMbps,
        baselineAllocatedMbps: slice.baselineAllocatedMbps,
        minGuaranteedMbps: slice.minGuaranteedMbps,
        priority: computeBusinessPriority(profile, policy),
        maxDegradationPercent: effectiveDegradationCeiling(department),
        harmCurvature: policy.harmCurvature[department.recoveryTolerance],
        recoveryIntoleranceScore: policy.recoveryIntoleranceScore[department.recoveryTolerance],
        recoveryWindowSeconds: policy.recoveryWindowSeconds[department.recoveryTolerance],
        downtimeCostPerMinute: department.downtimeCostPerMinute,
        slaStress: state.slaStress,
        burdenScore: slice.degradationHistory.burdenScore,
        telemetryAgeMs: Math.max(0, nowMs - state.observedAtMs),
      });
    }

    return candidates;
  }

  /** Notify operators, and the owners of every affected department. */
  private async announce(decision: ArbitrationDecision, plan: ArbitrationPlan): Promise<void> {
    const degraded = plan.allocations.filter((a) => a.disposition === SliceDisposition.DEGRADED);

    const severity =
      plan.verdict === ArbitrationVerdict.INFEASIBLE
        ? NotificationSeverity.CRITICAL
        : plan.verdict === ArbitrationVerdict.PARTIAL
          ? NotificationSeverity.ERROR
          : NotificationSeverity.WARNING;

    await this.notifications.create({
      severity,
      title:
        plan.verdict === ArbitrationVerdict.INFEASIBLE
          ? 'Contention could not be resolved automatically'
          : `${degraded.length} slice(s) degraded to resolve contention`,
      body:
        plan.verdict === ArbitrationVerdict.INFEASIBLE
          ? (plan.escalationReason ?? plan.rationale)
          : `Freed ${round(plan.achievedReductionMbps, 1)} Mbps by degrading ` +
            `${degraded.map((d) => `${d.sliceName} (${round(d.degradationPercent, 1)}%)`).join(', ')}. ` +
            `Confidence ${round(plan.confidence * 100, 0)}%.`,
      broadcast: true,
      minimumRole: UserRole.VIEWER,
      subject: { type: 'ArbitrationDecision', id: decision.id },
      link: `/arbitration/${decision.id}`,
      metadata: {
        contentionId: decision.contentionId,
        verdict: plan.verdict,
        confidence: plan.confidence,
        degradedCount: degraded.length,
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Manual operations                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Compute a plan without applying it.
   *
   * Lets an operator see exactly what the engine WOULD do before authorising it — which is
   * the difference between an automated system people trust and one they switch off.
   * Synthesises a provisional contention event when none is open, so "what would happen if
   * the network were contended right now" is answerable at any time.
   */
  async simulate(actor: ActorContext): Promise<ArbitrationPlan> {
    const snapshot = this.telemetry.getSnapshot();
    if (!snapshot || snapshot.slices.length === 0) {
      throw new ArbitrationInfeasibleError('No telemetry snapshot is available to simulate against');
    }

    const open = this.contention.getOpenEvent();
    const policy = await this.policies.getActiveResolved();
    const candidates = await this.buildCandidates(snapshot.slices, policy);

    const plan = arbitrate({
      contentionId: open?.id ?? 'SIMULATION',
      candidates,
      offeredCapacityMbps: snapshot.offeredCapacityMbps,
      totalDemandMbps: snapshot.totalDemandMbps,
      atMs: this.clock.now(),
      settings: policy.arbitration,
      policyId: policy.policyId,
      policyRevision: policy.revision,
      policyName: policy.policyName,
    });

    log.info({ actor: actor.userId, verdict: plan.verdict }, 'arbitration simulated');
    return plan;
  }

  /**
   * Administrator override — restore slices degraded by a decision.
   *
   * Requires a reason, which is recorded on the decision and in the audit trail. An
   * override with no recorded justification is exactly the unaccountable intervention this
   * platform exists to eliminate, so the reason is enforced by the schema rather than
   * requested by convention.
   */
  async override(
    decisionId: string,
    payload: { reason: string; restoreAll: boolean },
    actor: ActorContext,
  ): Promise<ArbitrationDecision> {
    const decision = await this.decisions.base.getById(decisionId);

    if (payload.restoreAll) {
      await this.allocation.restoreDecision(decision, actor, 'administrator override');
    }

    const updated = await this.decisions.base.update(decisionId, {
      overriddenBy: actor.userId,
      overrideReason: payload.reason,
      recoveryStatus: payload.restoreAll ? RecoveryStatus.RECOVERED : decision.recoveryStatus,
      ...(payload.restoreAll ? { fullyRecoveredAt: this.clock.nowIso() } : {}),
    });

    await this.audit.record({
      action: AuditAction.ARBITRATION_OVERRIDDEN,
      actor,
      summary: `Arbitration decision ${decisionId} overridden: ${payload.reason}`,
      target: { type: 'ArbitrationDecision', id: decisionId },
      metadata: { restoreAll: payload.restoreAll, reason: payload.reason },
    });

    await this.notifications.create({
      severity: NotificationSeverity.WARNING,
      title: 'Arbitration decision overridden',
      body: `${actor.email} overrode decision ${decisionId}: ${payload.reason}`,
      broadcast: true,
      minimumRole: UserRole.MANAGER,
      subject: { type: 'ArbitrationDecision', id: decisionId },
      link: `/arbitration/${decisionId}`,
    });

    log.warn({ decisionId, by: actor.userId, reason: payload.reason }, 'ARBITRATION OVERRIDDEN');
    return updated;
  }

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  async getById(id: string): Promise<ArbitrationDecision> {
    return this.decisions.base.getById(id);
  }

  async list(
    criteria: Parameters<ArbitrationRepository['search']>[0],
    page: { limit: number; cursor?: string },
  ): Promise<Page<ArbitrationDecision>> {
    return this.decisions.search(criteria, page);
  }

  async recent(limit = 20): Promise<ArbitrationDecision[]> {
    return this.decisions.recent(limit);
  }

  async forContention(contentionId: string): Promise<ArbitrationDecision[]> {
    return this.decisions.forContention(contentionId);
  }

  /**
   * Outcome summary for the Reports page.
   *
   * Range defaults are computed HERE, from the injected clock — not in the controller from
   * `Date.now()`. Mixing the two produces a window that silently excludes real decisions
   * whenever the two clocks differ, which is exactly what a time-travelling test or a
   * replay run does.
   */
  async summarise(range: { fromMs?: number; toMs?: number } = {}): Promise<ArbitrationSummary> {
    const toMs = range.toMs ?? this.clock.now();
    const fromMs = range.fromMs ?? toMs - 7 * 24 * 60 * 60 * 1000;

    const page = await this.decisions.search({ fromMs, toMs }, { limit: 500 });
    const decisions = page.items;

    if (decisions.length === 0) {
      return {
        fromMs,
        toMs,
        total: 0,
        byOutcome: {},
        totalBandwidthFreedMbps: 0,
        meanConfidence: 0,
        meanHarm: 0,
        harmAvoidedVsPrioritySortPercent: 0,
        degradationsByDepartment: [],
      };
    }

    const byOutcome: Record<string, number> = {};
    let bandwidthFreed = 0;
    let confidenceTotal = 0;
    let harmTotal = 0;
    let sortPenaltyTotal = 0;
    let sortComparisons = 0;
    const byDepartment = new Map<string, { name: string; count: number; mbps: number }>();

    for (const decision of decisions) {
      byOutcome[decision.outcome] = (byOutcome[decision.outcome] ?? 0) + 1;
      bandwidthFreed += decision.achievedReductionMbps;
      confidenceTotal += decision.confidence;
      harmTotal += decision.totalHarm;

      const prioritySort = decision.alternatives.find((a) => a.strategy === 'PRIORITY_SORT');
      // Only feasible comparisons contribute. An infeasible priority sort has a null
      // penalty because its lower harm reflects doing less, not doing better — averaging
      // that in would understate the platform's actual advantage.
      if (prioritySort?.harmPenaltyPercent != null) {
        sortPenaltyTotal += prioritySort.harmPenaltyPercent;
        sortComparisons += 1;
      }

      for (const allocation of decision.allocations) {
        if (allocation.disposition !== SliceDisposition.DEGRADED) continue;
        const bucket = byDepartment.get(allocation.departmentId) ?? {
          name: allocation.departmentName,
          count: 0,
          mbps: 0,
        };
        bucket.count += 1;
        bucket.mbps += allocation.reductionMbps;
        byDepartment.set(allocation.departmentId, bucket);
      }
    }

    return {
      fromMs,
      toMs,
      total: decisions.length,
      byOutcome,
      totalBandwidthFreedMbps: round(bandwidthFreed, 2),
      meanConfidence: round(confidenceTotal / decisions.length, 4),
      meanHarm: round(harmTotal / decisions.length, 4),
      // The platform's quantified value: how much business harm was avoided relative to
      // the conventional approach it replaces.
      harmAvoidedVsPrioritySortPercent:
        sortComparisons > 0 ? round(sortPenaltyTotal / sortComparisons, 2) : 0,
      degradationsByDepartment: [...byDepartment.entries()]
        .map(([departmentId, bucket]) => ({
          departmentId,
          departmentName: bucket.name,
          degradationCount: bucket.count,
          totalReducedMbps: round(bucket.mbps, 2),
        }))
        .sort((a, b) => b.degradationCount - a.degradationCount),
    };
  }
}

export interface ArbitrationSummary {
  fromMs: number;
  toMs: number;
  total: number;
  byOutcome: Record<string, number>;
  totalBandwidthFreedMbps: number;
  meanConfidence: number;
  meanHarm: number;
  harmAvoidedVsPrioritySortPercent: number;
  degradationsByDepartment: {
    departmentId: string;
    departmentName: string;
    degradationCount: number;
    totalReducedMbps: number;
  }[];
}

export { ArbitrationOutcome };
