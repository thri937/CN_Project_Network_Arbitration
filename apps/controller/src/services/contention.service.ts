import { EventEmitter } from 'node:events';
import { AuditAction, ContentionStatus } from '@/constants/enums';
import { ContentionTunables } from '@/constants/tunables';
import type { IClock } from '@/interfaces/clock.port';
import type { CapacityState } from '@/models/capacity.model';
import {
  severityFor,
  type ContentionEvent,
  type ContentionParticipant,
} from '@/models/contention.model';
import type { NetworkSnapshot } from '@/models/telemetry.model';
import type { ContentionRepository } from '@/repositories/contention.repository';
import { SYSTEM_ACTOR, type Page } from '@/types/common';
import { round, safeDivide } from '@/utils/math';
import { createLogger } from '@/utils/logger';
import type { AuditService } from './audit.service';

const log = createLogger('contention-detector');

/**
 * Runtime contention detector.
 *
 * THE HARD PROBLEM IS NOT DETECTING OVERLOAD — IT IS NOT DETECTING IT TOO EAGERLY.
 * ================================================================================
 * Total demand oscillates continuously around the capacity line. A naive
 * `if (demand > capacity) arbitrate()` fires and clears dozens of times a minute, and every
 * firing degrades slices, writes audit records and notifies people. The result is a
 * platform that is worse than no platform: it inflicts constant small degradations, none of
 * which are necessary, and buries the one event that mattered.
 *
 * Three mechanisms, each doing a distinct job:
 *
 *  1. THRESHOLD BAND (`DETECTION_THRESHOLD_RATIO`, 1.02)
 *     Demand must exceed capacity by a margin, not merely cross it. Absorbs measurement
 *     jitter around the line.
 *
 *  2. ASYMMETRIC CONFIRMATION / CLEARANCE (2 samples up, 3 samples down)
 *     Contention must persist to open, and persist harder to close. The asymmetry is
 *     deliberate: closing on the first quiet sample re-opens on the next noisy one, which
 *     produces exactly the flapping the debounce exists to prevent. Being slow to declare
 *     victory is cheap; being quick to is not.
 *
 *  3. COOLDOWN (`ARBITRATION_COOLDOWN_SECONDS`)
 *     A minimum interval between arbitration passes for the same event, so an applied plan
 *     has time to take effect before being judged. Without it the engine re-arbitrates on
 *     the very next tick, before any bandwidth change has propagated, and compounds
 *     degradations that were already sufficient.
 *
 * ONE OPEN EVENT AT A TIME
 * ========================
 * Contention is a property of the whole network — total demand either exceeds total
 * capacity or it does not. Per-slice events would mean N simultaneous "contentions" for one
 * physical condition, and N arbitration passes racing over the same pool of capacity.
 */

export interface ContentionEvents {
  /** A new contention has been confirmed and persisted. */
  detected: (event: ContentionEvent) => void;
  /** An open contention was re-observed this tick. */
  updated: (event: ContentionEvent) => void;
  /** Demand fell below threshold for long enough to close the event. */
  resolved: (event: ContentionEvent) => void;
}

export class ContentionService {
  private readonly emitter = new EventEmitter();

  /** Consecutive samples above threshold, before an event is opened. */
  private confirmationProgress = 0;
  /** In-memory mirror of the open event, so the hot path avoids a datastore read. */
  private openEvent: ContentionEvent | null = null;
  private loaded = false;

  constructor(
    private readonly contention: ContentionRepository,
    private readonly audit: AuditService,
    private readonly clock: IClock,
  ) {
    this.emitter.setMaxListeners(50);
  }

  on<E extends keyof ContentionEvents>(event: E, listener: ContentionEvents[E]): void {
    this.emitter.on(event, listener);
  }

  off<E extends keyof ContentionEvents>(event: E, listener: ContentionEvents[E]): void {
    this.emitter.off(event, listener);
  }

  /**
   * Recover the open event after a restart.
   *
   * Without this, a process restart during an incident would lose track of an in-flight
   * contention, immediately re-detect it as new, and reset the cooldown — re-arbitrating a
   * network that had already been mitigated.
   */
  async initialise(): Promise<void> {
    if (this.loaded) return;
    this.openEvent = await this.contention.findOpen();
    this.loaded = true;

    if (this.openEvent) {
      log.warn(
        { contentionId: this.openEvent.id, status: this.openEvent.status },
        'recovered an open contention event from a previous process',
      );
    }
  }

  /**
   * Evaluate one tick.
   *
   * Never throws: a detector failure must not stop the telemetry loop that feeds it.
   * @returns the open contention event, or null when the network is not contended.
   */
  async evaluate(snapshot: NetworkSnapshot, capacity: CapacityState): Promise<ContentionEvent | null> {
    try {
      const contended = capacity.demandRatio >= ContentionTunables.DETECTION_THRESHOLD_RATIO;

      return contended
        ? await this.handleContended(snapshot, capacity)
        : await this.handleUncontended(capacity);
    } catch (error) {
      log.error({ err: error }, 'contention evaluation failed');
      return this.openEvent;
    }
  }

  private async handleContended(
    snapshot: NetworkSnapshot,
    capacity: CapacityState,
  ): Promise<ContentionEvent | null> {
    // An open event: refresh its running state rather than opening another.
    if (this.openEvent) {
      // Any above-threshold sample resets clearance progress. Partial progress toward
      // "resolved" must not survive a relapse, or a flapping network would eventually
      // accumulate enough scattered quiet samples to close a live contention.
      this.openEvent = await this.contention.base.update(this.openEvent.id, {
        currentDemandRatio: capacity.demandRatio,
        currentExcessMbps: capacity.excessDemandMbps,
        peakDemandRatio: Math.max(this.openEvent.peakDemandRatio, capacity.demandRatio),
        peakExcessMbps: Math.max(this.openEvent.peakExcessMbps, capacity.excessDemandMbps),
        severity: severityFor(Math.max(this.openEvent.peakDemandRatio, capacity.demandRatio)),
        clearanceProgress: 0,
      });

      this.emitter.emit('updated', this.openEvent);
      return this.openEvent;
    }

    // No open event: accumulate confirmation.
    this.confirmationProgress += 1;
    if (this.confirmationProgress < ContentionTunables.CONFIRMATION_SAMPLES) {
      log.debug(
        {
          progress: this.confirmationProgress,
          required: ContentionTunables.CONFIRMATION_SAMPLES,
          demandRatio: capacity.demandRatio,
        },
        'contention suspected; awaiting confirmation',
      );
      return null;
    }

    this.confirmationProgress = 0;
    return this.open(snapshot, capacity);
  }

  private async handleUncontended(capacity: CapacityState): Promise<ContentionEvent | null> {
    // A quiet sample erases partial confirmation — transient spikes must not accumulate
    // across minutes into a spurious detection.
    this.confirmationProgress = 0;

    if (!this.openEvent) return null;

    const progress = this.openEvent.clearanceProgress + 1;

    if (progress < ContentionTunables.CLEARANCE_SAMPLES) {
      this.openEvent = await this.contention.base.update(this.openEvent.id, {
        clearanceProgress: progress,
        currentDemandRatio: capacity.demandRatio,
        currentExcessMbps: capacity.excessDemandMbps,
      });
      return this.openEvent;
    }

    return this.resolve(capacity);
  }

  private async open(snapshot: NetworkSnapshot, capacity: CapacityState): Promise<ContentionEvent> {
    const now = this.clock.now();
    const totalDemand = snapshot.totalDemandMbps;

    const participants: ContentionParticipant[] = snapshot.slices
      .map((slice) => ({
        sliceId: slice.sliceId,
        sliceCode: slice.sliceCode,
        departmentId: slice.departmentId,
        demandMbps: round(slice.demandMbps, 3),
        allocatedMbps: round(slice.allocatedMbps, 3),
        demandShare: round(safeDivide(slice.demandMbps, totalDemand, 0), 5),
      }))
      .sort((a, b) => b.demandMbps - a.demandMbps);

    const event = await this.contention.base.create({
      status: ContentionStatus.DETECTED,
      severity: severityFor(capacity.demandRatio),
      detectedAt: new Date(now).toISOString(),
      detectedAtMs: now,
      offeredCapacityMbps: capacity.offeredCapacityMbps,
      demandAtDetectionMbps: capacity.demandMbps,
      allocatedAtDetectionMbps: capacity.allocatedMbps,
      demandRatioAtDetection: capacity.demandRatio,
      excessDemandMbps: capacity.excessDemandMbps,
      peakDemandRatio: capacity.demandRatio,
      peakExcessMbps: capacity.excessDemandMbps,
      currentDemandRatio: capacity.demandRatio,
      currentExcessMbps: capacity.excessDemandMbps,
      participants,
      arbitrationCount: 0,
      decisionIds: [],
      clearanceProgress: 0,
    });

    this.openEvent = event;

    log.warn(
      {
        contentionId: event.id,
        severity: event.severity,
        demandRatio: capacity.demandRatio,
        excessMbps: capacity.excessDemandMbps,
        participants: participants.length,
      },
      'CONTENTION DETECTED',
    );

    await this.audit.record({
      action: AuditAction.CONTENTION_DETECTED,
      actor: SYSTEM_ACTOR,
      summary:
        `Contention detected: demand ${round(capacity.demandMbps)} Mbps against ` +
        `${round(capacity.offeredCapacityMbps)} Mbps offered ` +
        `(${round(capacity.demandRatio * 100, 1)}% of capacity, ${event.severity})`,
      target: { type: 'ContentionEvent', id: event.id },
      metadata: {
        demandRatio: capacity.demandRatio,
        excessMbps: capacity.excessDemandMbps,
        participantCount: participants.length,
      },
    });

    this.emitter.emit('detected', event);
    return event;
  }

  private async resolve(capacity: CapacityState): Promise<null> {
    const event = this.openEvent;
    if (!event) return null;

    const now = this.clock.now();
    const resolved = await this.contention.base.update(event.id, {
      status: ContentionStatus.RESOLVED,
      resolvedAt: new Date(now).toISOString(),
      resolvedAtMs: now,
      durationSeconds: round((now - event.detectedAtMs) / 1000, 2),
      currentDemandRatio: capacity.demandRatio,
      currentExcessMbps: 0,
      clearanceProgress: ContentionTunables.CLEARANCE_SAMPLES,
    });

    this.openEvent = null;

    log.info(
      {
        contentionId: resolved.id,
        durationSeconds: resolved.durationSeconds,
        arbitrations: resolved.arbitrationCount,
        peakDemandRatio: resolved.peakDemandRatio,
      },
      'contention resolved',
    );

    await this.audit.record({
      action: AuditAction.CONTENTION_DETECTED,
      actor: SYSTEM_ACTOR,
      summary:
        `Contention resolved after ${resolved.durationSeconds}s ` +
        `(peak ${round(resolved.peakDemandRatio * 100, 1)}% of capacity, ` +
        `${resolved.arbitrationCount} arbitration pass(es))`,
      target: { type: 'ContentionEvent', id: resolved.id },
      metadata: {
        durationSeconds: resolved.durationSeconds,
        peakDemandRatio: resolved.peakDemandRatio,
        arbitrationCount: resolved.arbitrationCount,
      },
    });

    this.emitter.emit('resolved', resolved);
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Arbitration coordination                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Whether the arbitration engine may run for the open event.
   *
   * The cooldown is what stops the engine re-arbitrating before an applied plan has had a
   * chance to take effect — which would compound degradations that were already sufficient.
   */
  canArbitrate(event: ContentionEvent): { allowed: boolean; reason?: string; waitSeconds?: number } {
    if (event.status === ContentionStatus.ARBITRATING) {
      return { allowed: false, reason: 'an arbitration pass is already in flight' };
    }
    if (event.status === ContentionStatus.RESOLVED || event.status === ContentionStatus.EXPIRED) {
      return { allowed: false, reason: `contention is ${event.status}` };
    }

    if (event.lastArbitrationAtMs !== undefined) {
      const elapsed = (this.clock.now() - event.lastArbitrationAtMs) / 1000;
      const cooldown = ContentionTunables.ARBITRATION_COOLDOWN_SECONDS;
      if (elapsed < cooldown) {
        return {
          allowed: false,
          reason: `cooldown active; the previous plan needs time to take effect`,
          waitSeconds: round(cooldown - elapsed, 1),
        };
      }
    }

    return { allowed: true };
  }

  /** Mark the event as being arbitrated, so a concurrent tick cannot start a second pass. */
  async markArbitrating(eventId: string): Promise<ContentionEvent> {
    const updated = await this.contention.base.update(eventId, {
      status: ContentionStatus.ARBITRATING,
    });
    if (this.openEvent?.id === eventId) this.openEvent = updated;
    return updated;
  }

  /** Record the outcome of an arbitration pass against the event. */
  async recordArbitration(
    eventId: string,
    outcome: { decisionId: string; mitigated: boolean; unresolvableReason?: string },
  ): Promise<ContentionEvent> {
    const current = await this.contention.base.getById(eventId);
    const now = this.clock.now();

    const updated = await this.contention.base.applyUpdate(current, {
      status: outcome.mitigated ? ContentionStatus.MITIGATED : ContentionStatus.UNRESOLVABLE,
      arbitrationCount: current.arbitrationCount + 1,
      lastArbitrationAt: new Date(now).toISOString(),
      lastArbitrationAtMs: now,
      decisionIds: [...current.decisionIds, outcome.decisionId].slice(-100),
      ...(outcome.unresolvableReason ? { unresolvableReason: outcome.unresolvableReason } : {}),
    });

    if (this.openEvent?.id === eventId) this.openEvent = updated;
    return updated;
  }

  /** Return the event to MITIGATED/DETECTED after a failed pass, so it can be retried. */
  async releaseArbitrating(eventId: string, reason: string): Promise<void> {
    const current = await this.contention.base.findById(eventId);
    if (!current || current.status !== ContentionStatus.ARBITRATING) return;

    const updated = await this.contention.base.applyUpdate(current, {
      status: current.arbitrationCount > 0 ? ContentionStatus.MITIGATED : ContentionStatus.DETECTED,
    });
    if (this.openEvent?.id === eventId) this.openEvent = updated;

    log.warn({ contentionId: eventId, reason }, 'arbitration pass released without a decision');
  }

  /* ------------------------------------------------------------------ */

  getOpenEvent(): ContentionEvent | null {
    return this.openEvent;
  }

  async getById(id: string): Promise<ContentionEvent> {
    return this.contention.base.getById(id);
  }

  async list(
    criteria: Parameters<ContentionRepository['search']>[0],
    page: { limit: number; cursor?: string },
  ): Promise<Page<ContentionEvent>> {
    return this.contention.search(criteria, page);
  }

  async recent(limit = 20): Promise<ContentionEvent[]> {
    return this.contention.recent(limit);
  }

  /** Test/teardown hook — clears in-memory detector state. */
  clear(): void {
    this.confirmationProgress = 0;
    this.openEvent = null;
    this.loaded = false;
  }

  healthProbe = (): { status: 'up' | 'degraded'; message?: string; details?: Record<string, unknown> } => {
    if (!this.openEvent) return { status: 'up', details: { openContention: null } };

    return {
      // An open contention is a network condition, not a platform fault — the platform is
      // working exactly as intended. It is surfaced as `degraded` so it appears on the
      // health endpoint an operator watches, without failing a readiness gate and pulling
      // the instance out of rotation precisely when it is most needed.
      status: 'degraded',
      message: `contention ${this.openEvent.id} is open (${this.openEvent.severity})`,
      details: {
        contentionId: this.openEvent.id,
        status: this.openEvent.status,
        severity: this.openEvent.severity,
        demandRatio: this.openEvent.currentDemandRatio,
        arbitrationCount: this.openEvent.arbitrationCount,
      },
    };
  };
}
