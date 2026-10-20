import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '@/config/env';
import { ErrorCode } from '@/constants/errorCodes';
import {
  ArbitrationOutcome,
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
  RecoveryStatus,
  SliceDisposition,
  SliceProfile,
  SliceStatus,
  UserRole,
} from '@/constants/enums';
import { ContentionTunables } from '@/constants/tunables';
import { createTestHarness, type SignedInUser, type TestHarness } from '../helpers/testApp';

const API = env.API_PREFIX;

/**
 * END-TO-END CONTROL LOOP
 * =======================
 * Congestion → detection → arbitration → degradation → recovery, exercised through the real
 * services with nothing stubbed. This is the test that proves the platform actually works
 * rather than merely compiling.
 */
describe('control loop end to end', () => {
  let harness: TestHarness;
  let app: Express;
  let admin: SignedInUser;
  let manager: SignedInUser;
  let viewer: SignedInUser;

  const collect = () => harness.container.services.telemetry.collect();
  const contention = () => harness.container.services.contention;
  const arbitration = () => harness.container.services.arbitration;

  const setLoad = (m: number) =>
    (harness.container.telemetryProvider as { setGlobalLoad?: (m: number) => number }).setGlobalLoad?.(m);

  const runTicks = async (n: number) => {
    for (let i = 0; i < n; i += 1) await collect();
  };

  /** Create a department and one slice on it. */
  const provision = async (options: {
    name: string;
    criticality: DepartmentCriticality;
    compliance?: ComplianceLevel;
    tolerance?: RecoveryTolerance;
    maxDegradation?: number;
    downtimeCost?: number;
    baselineMbps: number;
    minMbps: number;
  }) => {
    const dept = await request(app)
      .post(`${API}/departments`)
      .set('Authorization', manager.auth)
      .send({
        name: options.name,
        criticality: options.criticality,
        businessImportance: options.criticality === DepartmentCriticality.MISSION_CRITICAL ? 95 : 40,
        downtimeCostPerMinute: options.downtimeCost ?? 1000,
        recoveryTolerance: options.tolerance ?? RecoveryTolerance.MODERATE,
        maxAllowedDegradationPercent: options.maxDegradation ?? 40,
        complianceLevel: options.compliance ?? ComplianceLevel.INTERNAL,
        customerImpact:
          options.criticality === DepartmentCriticality.MISSION_CRITICAL
            ? CustomerImpact.SEVERE_EXTERNAL
            : CustomerImpact.INTERNAL_ONLY,
        operationalImportance: options.criticality === DepartmentCriticality.MISSION_CRITICAL ? 90 : 35,
      })
      .expect(201);

    const slice = await request(app)
      .post(`${API}/slices`)
      .set('Authorization', manager.auth)
      .send({
        name: `${options.name} Slice`,
        departmentId: dept.body.data.id,
        snssai: { sst: 1 },
        profile: SliceProfile.EMBB,
        baselineAllocatedMbps: options.baselineMbps,
        minGuaranteedMbps: options.minMbps,
        maxBurstMbps: options.baselineMbps * 2,
        slaTargets: {
          maxLatencyMs: 60,
          maxJitterMs: 12,
          maxPacketLossPercent: 2,
          minThroughputMbps: Math.round(options.baselineMbps * 0.2),
          availabilityPercent: 99.9,
        },
      })
      .expect(201);

    return { departmentId: dept.body.data.id as string, sliceId: slice.body.data.id as string };
  };

  /** Drive the network into a confirmed contention. */
  const induceContention = async (multiplier = 6) => {
    setLoad(multiplier);
    await runTicks(ContentionTunables.CONFIRMATION_SAMPLES + 1);
    const event = contention().getOpenEvent();
    expect(event, 'expected a contention to be open').not.toBeNull();
    return event!;
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
    harness.container.services.capacity.clear();
    contention().clear();
    setLoad(1);

    admin = await harness.signInAs(UserRole.ADMIN, 'loop-admin@corp.example');
    manager = await harness.signInAs(UserRole.MANAGER, 'loop-manager@corp.example');
    viewer = await harness.signInAs(UserRole.VIEWER, 'loop-viewer@corp.example');
  });

  /* ================================================================== */
  describe('full cycle', () => {
    it('detects contention, arbitrates, degrades, and records everything', async () => {
      const critical = await provision({
        name: 'Clinical Systems',
        criticality: DepartmentCriticality.MISSION_CRITICAL,
        compliance: ComplianceLevel.REGULATED,
        tolerance: RecoveryTolerance.ZERO,
        maxDegradation: 20,
        downtimeCost: 50_000,
        baselineMbps: 4000,
        minMbps: 500,
      });

      const ordinary = await provision({
        name: 'Digital Signage',
        criticality: DepartmentCriticality.BEST_EFFORT,
        compliance: ComplianceLevel.NONE,
        tolerance: RecoveryTolerance.HIGH,
        maxDegradation: 60,
        downtimeCost: 20,
        baselineMbps: 8000,
        minMbps: 500,
      });

      // Baselines total 12,000 Mbps against 9,500 offered — the oversubscription the
      // platform exists to arbitrate. At this load both slices want more than their
      // baselines (~15,000 Mbps of demand), so the link carries ~12,000 and ~2,800 Mbps must
      // be shed: comfortably within the 4,800 Mbps both slices can give up
      // (20 % of 4000 plus 60 % of 8000), so the plan is FEASIBLE.
      const event = await induceContention(1.85);

      const { decision, plan } = await arbitration().run(event);

      expect(decision).not.toBeNull();
      expect(plan.verdict).toBe('FEASIBLE');
      expect(decision!.outcome).toBe(ArbitrationOutcome.RESOLVED);

      /* --- the business-driven outcome --- */
      const criticalAlloc = decision!.allocations.find((a) => a.sliceId === critical.sliceId)!;
      const ordinaryAlloc = decision!.allocations.find((a) => a.sliceId === ordinary.sliceId)!;

      // Signage absorbs more than clinical systems — on business grounds alone.
      expect(ordinaryAlloc.reductionMbps).toBeGreaterThan(criticalAlloc.reductionMbps);

      /* --- the slices actually changed --- */
      const signage = await request(app)
        .get(`${API}/slices/${ordinary.sliceId}`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(signage.body.data.status).toBe(SliceStatus.DEGRADED);
      expect(signage.body.data.allocatedMbps).toBeLessThan(8000);
      expect(signage.body.data.allocatedMbps).toBeGreaterThanOrEqual(500); // contractual floor
      expect(signage.body.data.activeDegradation.decisionId).toBe(decision!.id);
      expect(signage.body.data.activeDegradation.reason.length).toBeGreaterThan(50);

      /* --- and it is all recorded --- */
      expect(decision!.rationale.length).toBeGreaterThan(100);
      expect(decision!.alternatives.length).toBeGreaterThan(0);
      expect(decision!.policySnapshot.policyId).toBeTruthy();
      expect(decision!.confidence).toBeGreaterThan(0);
    });

    it('never degrades a LIFE_SAFETY slice even under extreme contention', async () => {
      const lifeSafety = await provision({
        name: 'Emergency Response',
        criticality: DepartmentCriticality.MISSION_CRITICAL,
        compliance: ComplianceLevel.LIFE_SAFETY,
        maxDegradation: 0,
        baselineMbps: 4000,
        minMbps: 1000,
      });

      await provision({
        name: 'Warehouse',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 60,
        baselineMbps: 8000,
        minMbps: 500,
      });

      const event = await induceContention(9);
      const { decision } = await arbitration().run(event);

      const alloc = decision!.allocations.find((a) => a.sliceId === lifeSafety.sliceId)!;
      expect(alloc.disposition).toBe(SliceDisposition.EXEMPT);
      expect(alloc.reductionMbps).toBe(0);

      const slice = await request(app)
        .get(`${API}/slices/${lifeSafety.sliceId}`)
        .set('Authorization', viewer.auth)
        .expect(200);
      expect(slice.body.data.allocatedMbps).toBe(4000);
      expect(slice.body.data.status).toBe(SliceStatus.ACTIVE);
    });

    it('never reduces a slice below its contractual floor', async () => {
      // Sized so the floor binds: ~6,800 Mbps must be shed but only 6,600 lies above the
      // 9,400 Mbps floor, so the plan is PARTIAL and stops exactly at the floor.
      const target = await provision({
        name: 'Floored',
        criticality: DepartmentCriticality.BEST_EFFORT,
        maxDegradation: 90,
        baselineMbps: 16000,
        minMbps: 9400,
      });

      const event = await induceContention(9);
      const { plan } = await arbitration().run(event);
      expect(plan.verdict).toBe('PARTIAL');

      const slice = await request(app)
        .get(`${API}/slices/${target.sliceId}`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(slice.body.data.allocatedMbps).toBeGreaterThanOrEqual(9400);
    });
  });

  /* ================================================================== */
  describe('recovery', () => {
    it('restores slices to baseline when the degradation window expires', async () => {
      const target = await provision({
        name: 'Recoverable',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        tolerance: RecoveryTolerance.MODERATE, // 600 s window
        maxDegradation: 60,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(8);
      const { decision } = await arbitration().run(event);
      expect(decision!.degradedSliceIds).toContain(target.sliceId);

      const degraded = await harness.container.repositories.slices.base.getById(target.sliceId);
      expect(degraded.allocatedMbps).toBeLessThan(12000);

      // Nothing happens before the window expires.
      await harness.container.services.allocation.recoverExpired();
      const stillDegraded = await harness.container.repositories.slices.base.getById(target.sliceId);
      expect(stillDegraded.status).toBe(SliceStatus.DEGRADED);

      // Advance past the recovery window.
      harness.clock.advance(601_000);
      const result = await harness.container.services.allocation.recoverExpired();

      expect(result.slicesRestored).toBeGreaterThan(0);

      const restored = await harness.container.repositories.slices.base.getById(target.sliceId);
      expect(restored.status).toBe(SliceStatus.ACTIVE);
      expect(restored.allocatedMbps).toBe(restored.baselineAllocatedMbps);
      expect(restored.activeDegradation).toBeUndefined();
      expect(restored.degradationHistory.lastRecoveredAt).toBeTruthy();
    });

    it('marks the decision fully recovered', async () => {
      await provision({
        name: 'Tracked',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 60,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(8);
      const { decision } = await arbitration().run(event);
      expect(decision!.recoveryStatus).toBe(RecoveryStatus.PENDING);

      harness.clock.advance(3_600_000);
      await harness.container.services.allocation.recoverExpired();

      const updated = await arbitration().getById(decision!.id);
      expect(updated.recoveryStatus).toBe(RecoveryStatus.RECOVERED);
      expect(updated.fullyRecoveredAt).toBeTruthy();
    });

    it('is idempotent — a second sweep restores nothing further', async () => {
      await provision({
        name: 'Idempotent',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 60,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(8);
      await arbitration().run(event);

      harness.clock.advance(3_600_000);
      const first = await harness.container.services.allocation.recoverExpired();
      const second = await harness.container.services.allocation.recoverExpired();

      expect(first.slicesRestored).toBeGreaterThan(0);
      expect(second.slicesRestored).toBe(0);
    });
  });

  /* ================================================================== */
  describe('fairness across successive contentions', () => {
    it('rotates the degradation burden rather than picking the same victim', async () => {
      // Without memory the engine is deterministic and would choose identically every time,
      // so one department would absorb every contention for weeks.
      const a = await provision({
        name: 'Alpha Ops',
        criticality: DepartmentCriticality.BUSINESS_OPERATIONAL,
        maxDegradation: 50,
        baselineMbps: 6000,
        minMbps: 500,
      });
      const b = await provision({
        name: 'Beta Ops',
        criticality: DepartmentCriticality.BUSINESS_OPERATIONAL,
        maxDegradation: 50,
        baselineMbps: 6000,
        minMbps: 500,
      });

      const reductions = new Map<string, number>([
        [a.sliceId, 0],
        [b.sliceId, 0],
      ]);

      for (let round = 0; round < 3; round += 1) {
        contention().clear();
        harness.container.services.capacity.clear();

        const event = await induceContention(6);
        const { decision } = await arbitration().run(event);

        for (const allocation of decision!.allocations) {
          const running = reductions.get(allocation.sliceId);
          if (running !== undefined) {
            reductions.set(allocation.sliceId, running + allocation.reductionMbps);
          }
        }

        // Recover and advance so the next round starts clean.
        harness.clock.advance(3_600_000);
        await harness.container.services.allocation.recoverExpired();
        setLoad(0.3);
        await runTicks(ContentionTunables.CLEARANCE_SAMPLES + 1);
      }

      // Both departments carried some of the burden across the three events.
      expect(reductions.get(a.sliceId)).toBeGreaterThan(0);
      expect(reductions.get(b.sliceId)).toBeGreaterThan(0);
    });
  });

  /* ================================================================== */
  describe('HTTP surface', () => {
    it('simulates a plan without applying it', async () => {
      const target = await provision({
        name: 'Simulated',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      await induceContention(7);

      const res = await request(app)
        .post(`${API}/arbitration/simulate`)
        .set('Authorization', manager.auth)
        .expect(200);

      expect(res.body.data.applied).toBe(false);
      expect(res.body.data.plan.allocations.length).toBeGreaterThan(0);

      // Nothing actually changed.
      const slice = await harness.container.repositories.slices.base.getById(target.sliceId);
      expect(slice.status).toBe(SliceStatus.ACTIVE);
      expect(slice.allocatedMbps).toBe(12000);
    });

    it('denies simulation to VIEWER', async () => {
      // It reveals every department's business score.
      await provision({
        name: 'Private',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        baselineMbps: 4000,
        minMbps: 500,
      });
      await collect();

      await request(app)
        .post(`${API}/arbitration/simulate`)
        .set('Authorization', viewer.auth)
        .expect(403);
    });

    it('refuses a manual trigger when nothing is contended', async () => {
      await provision({
        name: 'Calm',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        baselineMbps: 500,
        minMbps: 100,
      });
      setLoad(0.2);
      await runTicks(3);

      const res = await request(app)
        .post(`${API}/arbitration/trigger`)
        .set('Authorization', manager.auth)
        .send({ dryRun: false })
        .expect(409);

      expect(res.body.error.message).toContain('no open contention');
    });

    it('applies a manual trigger and returns the decision', async () => {
      await provision({
        name: 'Triggered',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      await induceContention(7);

      const res = await request(app)
        .post(`${API}/arbitration/trigger`)
        .set('Authorization', manager.auth)
        .send({ dryRun: false })
        .expect(200);

      expect(res.body.data.applied).toBe(true);
      expect(res.body.data.decision.trigger).toBe('MANUAL');
      expect(res.body.data.decision.administrator).toBe(manager.userId);
    });

    it('lets any authenticated user read the decision that affected them', async () => {
      // A department head must be able to read the justification for their own degradation.
      await provision({
        name: 'Readable',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(7);
      const { decision } = await arbitration().run(event);

      const res = await request(app)
        .get(`${API}/arbitration/${decision!.id}`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.rationale).toBeTruthy();
      expect(res.body.data.alternatives.length).toBeGreaterThan(0);
      expect(res.body.data.allocations[0].factors).toBeDefined();
    });

    it('reports the harm avoided versus a conventional priority sort', async () => {
      await provision({
        name: 'Benchmarked A',
        criticality: DepartmentCriticality.BUSINESS_CRITICAL,
        tolerance: RecoveryTolerance.ZERO,
        maxDegradation: 40,
        baselineMbps: 6000,
        minMbps: 500,
      });
      await provision({
        name: 'Benchmarked B',
        criticality: DepartmentCriticality.BEST_EFFORT,
        tolerance: RecoveryTolerance.HIGH,
        maxDegradation: 60,
        baselineMbps: 6000,
        minMbps: 500,
      });

      const event = await induceContention(7);
      await arbitration().run(event);

      const res = await request(app)
        .get(`${API}/arbitration/summary`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.total).toBeGreaterThan(0);
      expect(res.body.data.harmAvoidedVsPrioritySortPercent).toBeGreaterThanOrEqual(0);
      expect(res.body.data.degradationsByDepartment.length).toBeGreaterThan(0);
    });
  });

  /* ================================================================== */
  describe('administrator override', () => {
    it('restores all slices and records the reason', async () => {
      const target = await provision({
        name: 'Overridden',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(7);
      const { decision } = await arbitration().run(event);

      const res = await request(app)
        .post(`${API}/arbitration/${decision!.id}/override`)
        .set('Authorization', admin.auth)
        .send({ reason: 'Plant manager escalated; restoring pending manual capacity review.', restoreAll: true })
        .expect(200);

      expect(res.body.data.overriddenBy).toBe(admin.userId);
      expect(res.body.data.recoveryStatus).toBe(RecoveryStatus.RECOVERED);

      const restored = await harness.container.repositories.slices.base.getById(target.sliceId);
      expect(restored.allocatedMbps).toBe(12000);
      expect(restored.status).toBe(SliceStatus.ACTIVE);
    });

    it('requires a substantive reason', async () => {
      // An override with no recorded justification is the unaccountable intervention this
      // platform exists to eliminate.
      await provision({
        name: 'NeedsReason',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(7);
      const { decision } = await arbitration().run(event);

      await request(app)
        .post(`${API}/arbitration/${decision!.id}/override`)
        .set('Authorization', admin.auth)
        .send({ reason: 'nope', restoreAll: true })
        .expect(400);
    });

    it('denies override to MANAGER', async () => {
      await provision({
        name: 'AdminOnly',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(7);
      const { decision } = await arbitration().run(event);

      await request(app)
        .post(`${API}/arbitration/${decision!.id}/override`)
        .set('Authorization', manager.auth)
        .send({ reason: 'I would like to override this decision please.', restoreAll: true })
        .expect(403);
    });
  });

  /* ================================================================== */
  describe('audit and notifications', () => {
    it('writes an audit record atomically with the degradation', async () => {
      await provision({
        name: 'Audited',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(7);
      const { decision } = await arbitration().run(event);

      const entries = await harness.container.services.audit.timelineFor(decision!.id);
      const executed = entries.find((e) => e.action === 'ARBITRATION_EXECUTED');

      expect(executed).toBeDefined();
      expect(executed!.metadata?.contentionId).toBe(event.id);
      expect(executed!.metadata?.confidence).toBeDefined();
    });

    it('notifies operators of the degradation', async () => {
      await provision({
        name: 'Notified',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(7);
      await arbitration().run(event);

      const res = await request(app)
        .get(`${API}/notifications`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].title).toContain('degraded');
      expect(res.body.data[0].link).toContain('/arbitration/');
    });

    it('exposes an unread count for the app shell badge', async () => {
      await provision({
        name: 'Badged',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(7);
      await arbitration().run(event);

      const res = await request(app)
        .get(`${API}/notifications/unread-count`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.count).toBeGreaterThan(0);
    });

    it('restricts the audit log to administrators', async () => {
      await request(app).get(`${API}/audit`).set('Authorization', viewer.auth).expect(403);
      await request(app).get(`${API}/audit`).set('Authorization', manager.auth).expect(403);
      await request(app).get(`${API}/audit`).set('Authorization', admin.auth).expect(200);
    });

    it('offers no route by which an audit record could be mutated', async () => {
      // Immutability by construction, not by convention.
      const entries = await request(app)
        .get(`${API}/audit`)
        .set('Authorization', admin.auth)
        .expect(200);

      const id = entries.body.data[0]?.id;
      if (!id) return;

      await request(app).patch(`${API}/audit/${id}`).set('Authorization', admin.auth).send({}).expect(404);
      await request(app).delete(`${API}/audit/${id}`).set('Authorization', admin.auth).expect(404);
    });
  });

  /* ================================================================== */
  describe('automatic arbitration', () => {
    it('acts on a confirmed contention with no human involvement', async () => {
      // The default operating mode. Every other test in this file drives arbitration
      // explicitly for determinism; this one proves the loop closes on its own.
      const target = await provision({
        name: 'Autonomous',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      harness.container.autoArbitration.enabled = true;

      setLoad(7);
      await runTicks(ContentionTunables.CONFIRMATION_SAMPLES + 3);
      // The control-loop handler is fire-and-forget; let its microtasks drain.
      await new Promise((resolve) => setImmediate(resolve));

      const slice = await harness.container.repositories.slices.base.getById(target.sliceId);
      expect(slice.status).toBe(SliceStatus.DEGRADED);
      expect(slice.allocatedMbps).toBeLessThan(12000);

      const decisions = await arbitration().recent(5);
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions[0]!.trigger).toBe('AUTOMATIC');
      expect(decisions[0]!.administrator).toBe('system');
    });
  });

  describe('safety gates', () => {
    it('refuses to arbitrate without a telemetry snapshot', async () => {
      await provision({
        name: 'Blind',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(7);

      // Wipe the snapshot: the platform must not act on an unobserved network.
      harness.container.services.telemetry.clearSnapshot();

      await expect(arbitration().run(event)).rejects.toMatchObject({
        code: ErrorCode.ARBITRATION_INFEASIBLE,
      });
    });

    it('enforces the cooldown between passes', async () => {
      await provision({
        name: 'Cooled',
        criticality: DepartmentCriticality.ADMINISTRATIVE,
        maxDegradation: 50,
        baselineMbps: 12000,
        minMbps: 1000,
      });

      const event = await induceContention(7);
      await arbitration().run(event);

      const reloaded = await contention().getById(event.id);
      await expect(arbitration().run(reloaded)).rejects.toMatchObject({
        statusCode: 409,
      });
    });
  });
});
