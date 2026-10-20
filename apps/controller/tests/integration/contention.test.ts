import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '@/config/env';
import {
  ComplianceLevel,
  ContentionSeverity,
  ContentionStatus,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
  SliceProfile,
  UserRole,
} from '@/constants/enums';
import { ContentionTunables } from '@/constants/tunables';
import { CapacityLevel } from '@/models/capacity.model';
import { severityFor } from '@/models/contention.model';
import { createTestHarness, type SignedInUser, type TestHarness } from '../helpers/testApp';

const API = env.API_PREFIX;

describe('capacity monitor & contention detector', () => {
  let harness: TestHarness;
  let app: Express;
  let manager: SignedInUser;
  let viewer: SignedInUser;
  let departmentId: string;

  const collect = () => harness.container.services.telemetry.collect();
  const capacity = () => harness.container.services.capacity;
  const contention = () => harness.container.services.contention;

  /** Drive the fleet hard enough to oversubscribe, then run `ticks` cycles. */
  const runAtLoad = async (multiplier: number, ticks: number) => {
    const provider = harness.container.telemetryProvider as { setGlobalLoad?: (m: number) => number };
    provider.setGlobalLoad?.(multiplier);
    for (let i = 0; i < ticks; i += 1) await collect();
  };

  const createSlice = async (name: string, baselineMbps: number) => {
    const res = await request(app)
      .post(`${API}/slices`)
      .set('Authorization', manager.auth)
      .send({
        name,
        departmentId,
        snssai: { sst: 1 },
        profile: SliceProfile.EMBB,
        baselineAllocatedMbps: baselineMbps,
        minGuaranteedMbps: Math.round(baselineMbps * 0.3),
        maxBurstMbps: baselineMbps * 2,
        slaTargets: {
          maxLatencyMs: 50,
          maxJitterMs: 10,
          maxPacketLossPercent: 1,
          minThroughputMbps: Math.round(baselineMbps * 0.2),
          availabilityPercent: 99.9,
        },
      })
      .expect(201);
    return res.body.data.id as string;
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    await harness.reset();
    capacity().clear();
    contention().clear();
    (harness.container.telemetryProvider as { setGlobalLoad?: (m: number) => number }).setGlobalLoad?.(1);

    manager = await harness.signInAs(UserRole.MANAGER, 'ctn-manager@corp.example');
    viewer = await harness.signInAs(UserRole.VIEWER, 'ctn-viewer@corp.example');

    const dept = await request(app)
      .post(`${API}/departments`)
      .set('Authorization', manager.auth)
      .send({
        name: 'Operations',
        criticality: DepartmentCriticality.BUSINESS_CRITICAL,
        businessImportance: 70,
        downtimeCostPerMinute: 3000,
        recoveryTolerance: RecoveryTolerance.MODERATE,
        maxAllowedDegradationPercent: 40,
        complianceLevel: ComplianceLevel.INTERNAL,
        customerImpact: CustomerImpact.INDIRECT,
        operationalImportance: 65,
      })
      .expect(201);
    departmentId = dept.body.data.id;
  });

  /* ================================================================== */
  describe('capacity measurement', () => {
    it('distinguishes utilisation from demand', async () => {
      // The distinction the whole detector rests on. Utilisation saturates at 1.0 and
      // carries no information about HOW oversubscribed the network is; demand is
      // unbounded and is the only usable signal.
      await createSlice('Modest', 500);
      await runAtLoad(6, 5);

      const state = capacity().getState()!;

      expect(state.utilisation).toBeLessThanOrEqual(1.0001);
      expect(state.demandRatio).toBeGreaterThan(state.utilisation);
    });

    it('reports OVERSUBSCRIBED whenever demand exceeds offered capacity', async () => {
      await createSlice('Hungry', 9000);
      await runAtLoad(4, 5);

      const state = capacity().getState()!;
      expect(state.oversubscribed).toBe(true);
      expect(state.level).toBe(CapacityLevel.OVERSUBSCRIBED);
      expect(state.excessDemandMbps).toBeGreaterThan(0);
    });

    it('reports HEALTHY on a quiet network', async () => {
      await createSlice('Quiet', 200);
      await runAtLoad(0.3, 5);

      const state = capacity().getState()!;
      expect(state.oversubscribed).toBe(false);
      expect(state.level).toBe(CapacityLevel.HEALTHY);
      expect(state.availableMbps).toBeGreaterThan(0);
    });

    it('computes a utilisation trend once enough history exists', async () => {
      await createSlice('Trending', 1000);
      for (let i = 0; i < 3; i += 1) await collect();

      // Too little history to forecast responsibly.
      expect(capacity().getState()!.projectedUtilisation).toBeNull();

      for (let i = 0; i < 15; i += 1) await collect();
      expect(capacity().getState()!.projectedUtilisation).not.toBeNull();
      expect(Number.isFinite(capacity().getState()!.utilisationTrend)).toBe(true);
    });

    it('counts degraded slices', async () => {
      const sliceId = await createSlice('WillDegrade', 1000);
      await collect();
      expect(capacity().getState()!.degradedSliceCount).toBe(0);

      await harness.container.repositories.slices.base.update(sliceId, { status: 'DEGRADED' });
      await collect();
      expect(capacity().getState()!.degradedSliceCount).toBe(1);
    });

    it('serves the live capacity state over HTTP', async () => {
      await createSlice('Served', 800);
      await collect();

      const res = await request(app)
        .get(`${API}/capacity`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.available).toBe(true);
      expect(res.body.data.capacity.offeredCapacityMbps).toBe(
        env.NETWORK_TOTAL_CAPACITY_MBPS - env.NETWORK_RESERVED_CAPACITY_MBPS,
      );
      expect(res.body.data.admission.committedFloorMbps).toBeGreaterThan(0);
      expect(res.body.data.thresholds.warningUtilisation).toBeGreaterThan(0);
    });
  });

  /* ================================================================== */
  describe('detection debounce', () => {
    it('does not open an event on a single over-threshold sample', async () => {
      // One noisy sample must never degrade anyone's bandwidth.
      await createSlice('Spiky', 9000);
      await runAtLoad(5, 1);

      expect(contention().getOpenEvent()).toBeNull();
    });

    it('opens an event after the confirmation count is met', async () => {
      await createSlice('Sustained', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);

      const event = contention().getOpenEvent();
      expect(event).not.toBeNull();
      expect(event!.status).toBe(ContentionStatus.DETECTED);
      expect(event!.demandRatioAtDetection).toBeGreaterThan(1);
      expect(event!.participants.length).toBeGreaterThan(0);
    });

    it('resets partial confirmation when a quiet sample intervenes', async () => {
      // Transient spikes scattered over minutes must not accumulate into a detection.
      await createSlice('Flappy', 9000);

      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES - 1);
      expect(contention().getOpenEvent()).toBeNull();

      await runAtLoad(0.2, 1); // one quiet sample wipes the progress
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES - 1);

      expect(contention().getOpenEvent()).toBeNull();
    });

    it('does not open a second event while one is open', async () => {
      // Contention is a property of the whole network, so exactly one event at a time.
      await createSlice('Single', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES + 10);

      const open = await harness.container.repositories.contention.findAllOpen();
      expect(open).toHaveLength(1);
    });

    it('tracks the peak while the event is open', async () => {
      await createSlice('Peaking', 9000);
      await runAtLoad(3, ContentionTunables.CONFIRMATION_SAMPLES + 2);
      const afterModerate = contention().getOpenEvent()!.peakDemandRatio;

      await runAtLoad(8, 5);
      const afterSevere = contention().getOpenEvent()!.peakDemandRatio;

      expect(afterSevere).toBeGreaterThan(afterModerate);
    });
  });

  /* ================================================================== */
  describe('clearance debounce', () => {
    it('requires sustained recovery before resolving', async () => {
      await createSlice('Recovering', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      expect(contention().getOpenEvent()).not.toBeNull();

      // One quiet sample is not enough — closing early re-opens on the next noisy tick.
      await runAtLoad(0.2, ContentionTunables.CLEARANCE_SAMPLES - 1);
      expect(contention().getOpenEvent()).not.toBeNull();

      await runAtLoad(0.2, 1);
      expect(contention().getOpenEvent()).toBeNull();
    });

    it('resets clearance progress when contention relapses', async () => {
      await createSlice('Relapsing', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);

      await runAtLoad(0.2, ContentionTunables.CLEARANCE_SAMPLES - 1);
      expect(contention().getOpenEvent()!.clearanceProgress).toBeGreaterThan(0);

      await runAtLoad(5, 1); // relapse
      expect(contention().getOpenEvent()!.clearanceProgress).toBe(0);

      // The clock restarts: one more quiet sample must not be enough.
      await runAtLoad(0.2, 1);
      expect(contention().getOpenEvent()).not.toBeNull();
    });

    it('records duration and peak on resolution', async () => {
      await createSlice('Timed', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      const eventId = contention().getOpenEvent()!.id;

      harness.clock.advance(45_000);
      await runAtLoad(0.2, ContentionTunables.CLEARANCE_SAMPLES);

      const resolved = await contention().getById(eventId);
      expect(resolved.status).toBe(ContentionStatus.RESOLVED);
      expect(resolved.durationSeconds).toBeGreaterThan(0);
      expect(resolved.peakDemandRatio).toBeGreaterThan(1);
      expect(resolved.resolvedAtMs).toBeGreaterThan(resolved.detectedAtMs);
    });
  });

  /* ================================================================== */
  describe('severity', () => {
    it('classifies from the demand ratio', () => {
      expect(severityFor(1.02)).toBe(ContentionSeverity.MINOR);
      expect(severityFor(1.15)).toBe(ContentionSeverity.MODERATE);
      expect(severityFor(1.3)).toBe(ContentionSeverity.SEVERE);
      expect(severityFor(1.8)).toBe(ContentionSeverity.CRITICAL);
    });

    it('escalates as the overload deepens', async () => {
      await createSlice('Escalating', 9000);
      await runAtLoad(3, ContentionTunables.CONFIRMATION_SAMPLES + 2);
      const before = contention().getOpenEvent()!.severity;

      await runAtLoad(9, 6);
      const after = contention().getOpenEvent()!.severity;

      const rank = [
        ContentionSeverity.MINOR,
        ContentionSeverity.MODERATE,
        ContentionSeverity.SEVERE,
        ContentionSeverity.CRITICAL,
      ];
      expect(rank.indexOf(after)).toBeGreaterThanOrEqual(rank.indexOf(before));
    });
  });

  /* ================================================================== */
  describe('arbitration gating', () => {
    it('permits arbitration for a freshly detected event', async () => {
      await createSlice('Gated', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);

      expect(contention().canArbitrate(contention().getOpenEvent()!).allowed).toBe(true);
    });

    it('blocks a second pass during the cooldown', async () => {
      // Without this the engine re-arbitrates before the applied plan has propagated and
      // compounds degradations that were already sufficient.
      await createSlice('Cooldown', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      const eventId = contention().getOpenEvent()!.id;

      await contention().markArbitrating(eventId);
      const after = await contention().recordArbitration(eventId, {
        decisionId: 'ARB-TEST-1',
        mitigated: true,
      });

      const gate = contention().canArbitrate(after);
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toContain('cooldown');
      expect(gate.waitSeconds).toBeGreaterThan(0);
    });

    it('permits a further pass once the cooldown expires', async () => {
      await createSlice('Cooled', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      const eventId = contention().getOpenEvent()!.id;

      await contention().markArbitrating(eventId);
      await contention().recordArbitration(eventId, { decisionId: 'ARB-TEST-2', mitigated: true });

      harness.clock.advance((ContentionTunables.ARBITRATION_COOLDOWN_SECONDS + 1) * 1000);

      const event = await contention().getById(eventId);
      expect(contention().canArbitrate(event).allowed).toBe(true);
    });

    it('blocks a concurrent pass while one is in flight', async () => {
      await createSlice('Concurrent', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      const eventId = contention().getOpenEvent()!.id;

      const arbitrating = await contention().markArbitrating(eventId);
      const gate = contention().canArbitrate(arbitrating);

      expect(gate.allowed).toBe(false);
      expect(gate.reason).toContain('already in flight');
    });

    it('releases a stuck ARBITRATING event so it can be retried', async () => {
      await createSlice('Stuck', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      const eventId = contention().getOpenEvent()!.id;

      await contention().markArbitrating(eventId);
      await contention().releaseArbitrating(eventId, 'engine crashed');

      const released = await contention().getById(eventId);
      expect(released.status).toBe(ContentionStatus.DETECTED);
      expect(contention().canArbitrate(released).allowed).toBe(true);
    });

    it('records decision ids against the event', async () => {
      await createSlice('Linked', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      const eventId = contention().getOpenEvent()!.id;

      await contention().markArbitrating(eventId);
      await contention().recordArbitration(eventId, { decisionId: 'ARB-A', mitigated: true });
      harness.clock.advance((ContentionTunables.ARBITRATION_COOLDOWN_SECONDS + 1) * 1000);
      await contention().markArbitrating(eventId);
      await contention().recordArbitration(eventId, { decisionId: 'ARB-B', mitigated: true });

      const event = await contention().getById(eventId);
      expect(event.decisionIds).toEqual(['ARB-A', 'ARB-B']);
      expect(event.arbitrationCount).toBe(2);
    });

    it('marks an event UNRESOLVABLE when no feasible plan exists', async () => {
      await createSlice('Infeasible', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      const eventId = contention().getOpenEvent()!.id;

      await contention().markArbitrating(eventId);
      const event = await contention().recordArbitration(eventId, {
        decisionId: 'ARB-NONE',
        mitigated: false,
        unresolvableReason: 'every slice is already at its contractual floor',
      });

      expect(event.status).toBe(ContentionStatus.UNRESOLVABLE);
      expect(event.unresolvableReason).toContain('contractual floor');
    });
  });

  /* ================================================================== */
  describe('HTTP surface', () => {
    it('reports no open contention on a healthy network', async () => {
      await createSlice('Calm', 200);
      await runAtLoad(0.3, 3);

      const res = await request(app)
        .get(`${API}/contention/current`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.open).toBe(false);
      expect(res.body.data.event).toBeNull();
      expect(res.body.data.detector.confirmationSamples).toBe(
        ContentionTunables.CONFIRMATION_SAMPLES,
      );
    });

    it('exposes the open event and the arbitration gate', async () => {
      await createSlice('Exposed', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);

      const res = await request(app)
        .get(`${API}/contention/current`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.open).toBe(true);
      expect(res.body.data.event.severity).toBeTruthy();
      // "Why hasn't this triggered arbitration?" must be answerable from the UI.
      expect(res.body.data.arbitration.allowed).toBe(true);
    });

    it('lists contention history newest first', async () => {
      await createSlice('Historical', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      await runAtLoad(0.2, ContentionTunables.CLEARANCE_SAMPLES);
      harness.clock.advance(60_000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);

      const res = await request(app)
        .get(`${API}/contention`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.length).toBe(2);
      expect(res.body.data[0].detectedAtMs).toBeGreaterThanOrEqual(res.body.data[1].detectedAtMs);
    });

    it('filters by status', async () => {
      await createSlice('Filtered', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      await runAtLoad(0.2, ContentionTunables.CLEARANCE_SAMPLES);

      const res = await request(app)
        .get(`${API}/contention`)
        .set('Authorization', viewer.auth)
        .query({ status: ContentionStatus.RESOLVED })
        .expect(200);

      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].status).toBe(ContentionStatus.RESOLVED);
    });

    it('requires authentication', async () => {
      await request(app).get(`${API}/contention/current`).expect(401);
      await request(app).get(`${API}/capacity`).expect(401);
    });
  });

  /* ================================================================== */
  describe('audit trail', () => {
    it('records detection and resolution', async () => {
      await createSlice('Audited', 9000);
      await runAtLoad(5, ContentionTunables.CONFIRMATION_SAMPLES);
      const eventId = contention().getOpenEvent()!.id;

      await runAtLoad(0.2, ContentionTunables.CLEARANCE_SAMPLES);

      const entries = await harness.container.services.audit.timelineFor(eventId);
      expect(entries.length).toBe(2);
      expect(entries[0]!.summary).toContain('Contention detected');
      expect(entries[1]!.summary).toContain('Contention resolved');
      // Detected by the runtime, not by a person.
      expect(entries[0]!.actor.userId).toBe('system');
    });
  });
});
