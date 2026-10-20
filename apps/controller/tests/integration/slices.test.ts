import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { env, OFFERED_CAPACITY_MBPS } from '@/config/env';
import { ErrorCode } from '@/constants/errorCodes';
import {
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
  SliceProfile,
  SliceStatus,
  UserRole,
} from '@/constants/enums';
import { SLICE_TRANSITIONS, canTransition } from '@/models/slice.model';
import { createTestHarness, type SignedInUser, type TestHarness } from '../helpers/testApp';

const API = env.API_PREFIX;

const slaTargets = {
  maxLatencyMs: 20,
  maxJitterMs: 5,
  maxPacketLossPercent: 0.1,
  minThroughputMbps: 200,
  availabilityPercent: 99.99,
};

describe('slice management', () => {
  let harness: TestHarness;
  let app: Express;
  let admin: SignedInUser;
  let manager: SignedInUser;
  let viewer: SignedInUser;
  let departmentId: string;

  const sliceBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Plant Floor Automation',
    departmentId,
    snssai: { sst: 2, sd: '0000A1' },
    profile: SliceProfile.URLLC,
    baselineAllocatedMbps: 800,
    minGuaranteedMbps: 400,
    maxBurstMbps: 1200,
    slaTargets,
    ...overrides,
  });

  beforeAll(async () => {
    harness = await createTestHarness();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    await harness.reset();
    admin = await harness.signInAs(UserRole.ADMIN, 'slice-admin@corp.example');
    manager = await harness.signInAs(UserRole.MANAGER, 'slice-manager@corp.example');
    viewer = await harness.signInAs(UserRole.VIEWER, 'slice-viewer@corp.example');

    const dept = await request(app)
      .post(`${API}/departments`)
      .set('Authorization', manager.auth)
      .send({
        name: 'Manufacturing',
        criticality: DepartmentCriticality.MISSION_CRITICAL,
        businessImportance: 92,
        downtimeCostPerMinute: 8400,
        recoveryTolerance: RecoveryTolerance.LOW,
        maxAllowedDegradationPercent: 15,
        complianceLevel: ComplianceLevel.CONTRACTUAL,
        customerImpact: CustomerImpact.DIRECT,
        operationalImportance: 88,
      })
      .expect(201);

    departmentId = dept.body.data.id;
  });

  /* ================================================================== */
  describe('creation', () => {
    it('creates a slice at its baseline allocation', async () => {
      const res = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody())
        .expect(201);

      expect(res.body.data.code).toBe('plant-floor-automation');
      expect(res.body.data.status).toBe(SliceStatus.ACTIVE);
      // A new slice starts undegraded: allocation equals baseline.
      expect(res.body.data.allocatedMbps).toBe(800);
      expect(res.body.data.baselineAllocatedMbps).toBe(800);
      expect(res.body.data.degradationPercent).toBe(0);
      expect(res.body.data.arbitrable).toBe(true);
    });

    it('assigns a deterministic telemetry seed', async () => {
      const first = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody())
        .expect(201);

      expect(typeof first.body.data.telemetrySeed).toBe('number');

      await request(app)
        .delete(`${API}/slices/${first.body.data.id}`)
        .set('Authorization', admin.auth)
        .expect(204);

      const second = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody())
        .expect(201);

      // Same code → same seed → reproducible traffic pattern across restarts.
      expect(second.body.data.telemetrySeed).toBe(first.body.data.telemetrySeed);
    });

    it('defaults the S-NSSAI SST from the profile', async () => {
      const res = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send({ ...sliceBody(), snssai: {} })
        .expect(400); // sst is required by the schema

      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('rejects a slice for an unknown department', async () => {
      await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody({ departmentId: 'DEP-NOPE' }))
        .expect(404);
    });

    it('rejects a slice for an inactive department', async () => {
      await request(app)
        .patch(`${API}/departments/${departmentId}`)
        .set('Authorization', manager.auth)
        .send({ active: false })
        .expect(200);

      const res = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody())
        .expect(422);
      expect(res.body.error.code).toBe(ErrorCode.POLICY_VIOLATION);
    });

    it('rejects a duplicate code', async () => {
      await request(app).post(`${API}/slices`).set('Authorization', manager.auth).send(sliceBody()).expect(201);
      await request(app).post(`${API}/slices`).set('Authorization', manager.auth).send(sliceBody()).expect(409);
    });

    it('rejects a guaranteed minimum above the baseline', async () => {
      const res = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody({ minGuaranteedMbps: 900, baselineAllocatedMbps: 800 }))
        .expect(400);
      expect(res.body.error.details[0].field).toBe('minGuaranteedMbps');
    });

    it('rejects a burst ceiling below the baseline', async () => {
      const res = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody({ maxBurstMbps: 500, baselineAllocatedMbps: 800 }))
        .expect(400);
      expect(res.body.error.details[0].field).toBe('maxBurstMbps');
    });

    it('rejects a malformed slice differentiator', async () => {
      await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody({ snssai: { sst: 1, sd: 'XYZ' } }))
        .expect(400);
    });
  });

  /* ================================================================== */
  describe('admission control', () => {
    it('reports headroom against offered capacity', async () => {
      const res = await request(app)
        .get(`${API}/slices/headroom`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.offeredCapacityMbps).toBe(OFFERED_CAPACITY_MBPS);
      expect(res.body.data.committedFloorMbps).toBe(0);
      expect(res.body.data.availableFloorMbps).toBe(OFFERED_CAPACITY_MBPS);
    });

    it('refuses a slice whose floor would exceed offered capacity', async () => {
      // The invariant that keeps arbitration solvable: if every slice is already at its
      // contractual floor and the network is STILL oversubscribed, no plan can exist.
      await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(
          sliceBody({
            name: 'Huge Slice',
            minGuaranteedMbps: OFFERED_CAPACITY_MBPS - 100,
            baselineAllocatedMbps: OFFERED_CAPACITY_MBPS,
            maxBurstMbps: OFFERED_CAPACITY_MBPS,
          }),
        )
        .expect(201);

      const res = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(
          sliceBody({
            name: 'One Too Many',
            minGuaranteedMbps: 500,
            baselineAllocatedMbps: 600,
            maxBurstMbps: 700,
          }),
        )
        .expect(422);

      expect(res.body.error.code).toBe(ErrorCode.CAPACITY_EXCEEDED);
      expect(res.body.error.details.availableFloorMbps).toBe(100);
      expect(res.body.error.message).toContain('no feasible solution');
    });

    it('permits baseline oversubscription — the condition arbitration exists to manage', async () => {
      // Floors must fit; baselines need not. Oversubscription is the normal state.
      for (let i = 0; i < 4; i += 1) {
        await request(app)
          .post(`${API}/slices`)
          .set('Authorization', manager.auth)
          .send(
            sliceBody({
              name: `Oversubscribed ${i}`,
              minGuaranteedMbps: 1000,
              baselineAllocatedMbps: 4000,
              maxBurstMbps: 5000,
            }),
          )
          .expect(201);
      }

      const res = await request(app)
        .get(`${API}/slices/headroom`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.committedFloorMbps).toBe(4000);
      expect(res.body.data.committedBaselineMbps).toBe(16_000);
      expect(res.body.data.baselineOversubscriptionRatio).toBeGreaterThan(1);
    });

    it('re-validates the ordering rule against the merged entity on a partial patch', async () => {
      // Only `minGuaranteedMbps` is sent, so the schema's cross-field rule cannot fire —
      // it needs both operands. The service re-checks against the STORED baseline, which
      // is exactly the gap a schema-only validation would leave open.
      const create = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody({ minGuaranteedMbps: 400, baselineAllocatedMbps: 800, maxBurstMbps: 1200 }))
        .expect(201);

      const res = await request(app)
        .patch(`${API}/slices/${create.body.data.id}`)
        .set('Authorization', manager.auth)
        .send({ minGuaranteedMbps: 900 })
        .expect(422);

      expect(res.body.error.code).toBe(ErrorCode.POLICY_VIOLATION);
      expect(res.body.error.message).toContain('cannot exceed the baseline');
    });

    it('re-admits when the guaranteed minimum is raised, and refuses if it no longer fits', async () => {
      const small = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(
          sliceBody({
            name: 'Small Floor',
            minGuaranteedMbps: 400,
            baselineAllocatedMbps: 9000,
            maxBurstMbps: 9500,
          }),
        )
        .expect(201);

      await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(
          sliceBody({
            name: 'Big Floor',
            minGuaranteedMbps: OFFERED_CAPACITY_MBPS - 500,
            baselineAllocatedMbps: 9000,
            maxBurstMbps: 9500,
          }),
        )
        .expect(201);

      // Committed floor is now 400 + 9000 = 9400 against 9500 offered.
      // Raising the first slice's floor to 500 fits exactly.
      await request(app)
        .patch(`${API}/slices/${small.body.data.id}`)
        .set('Authorization', manager.auth)
        .send({ minGuaranteedMbps: 500 })
        .expect(200);

      // Raising it to 600 would commit 9600 — no feasible arbitration plan could exist.
      const res = await request(app)
        .patch(`${API}/slices/${small.body.data.id}`)
        .set('Authorization', manager.auth)
        .send({ minGuaranteedMbps: 600 })
        .expect(422);

      expect(res.body.error.code).toBe(ErrorCode.CAPACITY_EXCEEDED);
    });

    it('excludes paused slices from committed floors', async () => {
      const create = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody({ minGuaranteedMbps: 4000, baselineAllocatedMbps: 5000, maxBurstMbps: 6000 }))
        .expect(201);

      await request(app)
        .post(`${API}/slices/${create.body.data.id}/pause`)
        .set('Authorization', manager.auth)
        .send({ reason: 'planned maintenance' })
        .expect(200);

      const res = await request(app)
        .get(`${API}/slices/headroom`)
        .set('Authorization', viewer.auth)
        .expect(200);

      // A paused slice consumes nothing, so its floor is released.
      expect(res.body.data.committedFloorMbps).toBe(0);
    });
  });

  /* ================================================================== */
  describe('lifecycle', () => {
    let sliceId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody())
        .expect(201);
      sliceId = res.body.data.id;
    });

    it('pauses a slice and releases its allocation', async () => {
      const res = await request(app)
        .post(`${API}/slices/${sliceId}/pause`)
        .set('Authorization', manager.auth)
        .send({ reason: 'firmware upgrade' })
        .expect(200);

      expect(res.body.data.status).toBe(SliceStatus.PAUSED);
      expect(res.body.data.pausedReason).toBe('firmware upgrade');
      expect(res.body.data.arbitrable).toBe(false);
    });

    it('requires a reason to pause', async () => {
      await request(app)
        .post(`${API}/slices/${sliceId}/pause`)
        .set('Authorization', manager.auth)
        .send({})
        .expect(400);
    });

    it('resumes a paused slice at its baseline', async () => {
      await request(app)
        .post(`${API}/slices/${sliceId}/pause`)
        .set('Authorization', manager.auth)
        .send({ reason: 'maintenance' })
        .expect(200);

      const res = await request(app)
        .post(`${API}/slices/${sliceId}/resume`)
        .set('Authorization', manager.auth)
        .send({})
        .expect(200);

      expect(res.body.data.status).toBe(SliceStatus.ACTIVE);
      expect(res.body.data.allocatedMbps).toBe(800);
      expect(res.body.data.pausedReason).toBeUndefined();
    });

    it('rejects pausing an already-paused slice', async () => {
      await request(app)
        .post(`${API}/slices/${sliceId}/pause`)
        .set('Authorization', manager.auth)
        .send({ reason: 'first' })
        .expect(200);

      const res = await request(app)
        .post(`${API}/slices/${sliceId}/pause`)
        .set('Authorization', manager.auth)
        .send({ reason: 'second' })
        .expect(400);
      expect(res.body.error.code).toBe(ErrorCode.INVALID_STATE_TRANSITION);
    });

    it('rejects resuming an active slice', async () => {
      await request(app)
        .post(`${API}/slices/${sliceId}/resume`)
        .set('Authorization', manager.auth)
        .send({})
        .expect(400);
    });

    it('hard-deletes a slice with no arbitration history', async () => {
      await request(app)
        .delete(`${API}/slices/${sliceId}`)
        .set('Authorization', admin.auth)
        .expect(204);

      await request(app).get(`${API}/slices/${sliceId}`).set('Authorization', viewer.auth).expect(404);
    });

    it('terminates rather than deletes a slice that has arbitration history', async () => {
      // Audit records reference the slice by id; a dangling reference would make a past
      // decision unreadable.
      await harness.container.repositories.slices.base.update(sliceId, {
        degradationHistory: {
          totalEvents: 3,
          cumulativeDegradedSeconds: 900,
          burdenScore: 1.5,
          recentEvents: [],
        },
      });

      const res = await request(app)
        .delete(`${API}/slices/${sliceId}`)
        .set('Authorization', admin.auth)
        .expect(200);

      expect(res.body.data.deleted).toBe(false);
      expect(res.body.data.status).toBe('TERMINATED');

      const still = await request(app)
        .get(`${API}/slices/${sliceId}`)
        .set('Authorization', viewer.auth)
        .expect(200);
      expect(still.body.data.status).toBe(SliceStatus.TERMINATED);
    });

    it('refuses to update a terminated slice', async () => {
      await harness.container.repositories.slices.base.update(sliceId, {
        status: SliceStatus.TERMINATED,
      });

      await request(app)
        .patch(`${API}/slices/${sliceId}`)
        .set('Authorization', manager.auth)
        .send({ name: 'Renamed' })
        .expect(400);
    });
  });

  /* ================================================================== */
  describe('state machine', () => {
    it('is terminal at TERMINATED', () => {
      expect(SLICE_TRANSITIONS[SliceStatus.TERMINATED]).toEqual([]);
    });

    it('permits the degradation and recovery cycle', () => {
      expect(canTransition(SliceStatus.ACTIVE, SliceStatus.DEGRADED)).toBe(true);
      expect(canTransition(SliceStatus.DEGRADED, SliceStatus.RECOVERING)).toBe(true);
      expect(canTransition(SliceStatus.RECOVERING, SliceStatus.ACTIVE)).toBe(true);
      // Recovery can be interrupted by fresh contention.
      expect(canTransition(SliceStatus.RECOVERING, SliceStatus.DEGRADED)).toBe(true);
    });

    it('forbids reviving a terminated slice', () => {
      for (const status of Object.values(SliceStatus)) {
        expect(canTransition(SliceStatus.TERMINATED, status)).toBe(false);
      }
    });

    it('forbids degrading a paused slice', () => {
      // A paused slice consumes no capacity, so degrading it is meaningless.
      expect(canTransition(SliceStatus.PAUSED, SliceStatus.DEGRADED)).toBe(false);
    });

    it('lets an operator pause a degraded slice', () => {
      expect(canTransition(SliceStatus.DEGRADED, SliceStatus.PAUSED)).toBe(true);
    });
  });

  /* ================================================================== */
  describe('update semantics', () => {
    it('does not silently undo a degradation when the baseline is raised', async () => {
      const create = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody())
        .expect(201);

      // Simulate an applied degradation: allocation below baseline.
      await harness.container.repositories.slices.base.update(create.body.data.id, {
        allocatedMbps: 500,
        status: SliceStatus.DEGRADED,
      });

      const res = await request(app)
        .patch(`${API}/slices/${create.body.data.id}`)
        .set('Authorization', manager.auth)
        .send({ baselineAllocatedMbps: 1000 })
        .expect(200);

      expect(res.body.data.baselineAllocatedMbps).toBe(1000);
      // The applied degradation survives the baseline change.
      expect(res.body.data.allocatedMbps).toBe(500);
    });

    it('tracks the baseline when the slice is not degraded', async () => {
      const create = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody())
        .expect(201);

      const res = await request(app)
        .patch(`${API}/slices/${create.body.data.id}`)
        .set('Authorization', manager.auth)
        .send({ baselineAllocatedMbps: 1000 })
        .expect(200);

      expect(res.body.data.allocatedMbps).toBe(1000);
    });
  });

  /* ================================================================== */
  describe('topology & authorisation', () => {
    it('returns slices joined with their departments', async () => {
      await request(app).post(`${API}/slices`).set('Authorization', manager.auth).send(sliceBody()).expect(201);

      const res = await request(app)
        .get(`${API}/slices/topology`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].department.name).toBe('Manufacturing');
      expect(res.body.data[0].department.criticality).toBe(DepartmentCriticality.MISSION_CRITICAL);
      expect(res.body.data[0].slice.code).toBe('plant-floor-automation');
    });

    it('denies slice creation to VIEWER', async () => {
      await request(app)
        .post(`${API}/slices`)
        .set('Authorization', viewer.auth)
        .send(sliceBody())
        .expect(403);
    });

    it('lets MANAGER pause but not delete', async () => {
      const create = await request(app)
        .post(`${API}/slices`)
        .set('Authorization', manager.auth)
        .send(sliceBody())
        .expect(201);

      await request(app)
        .post(`${API}/slices/${create.body.data.id}/pause`)
        .set('Authorization', manager.auth)
        .send({ reason: 'ok' })
        .expect(200);

      await request(app)
        .delete(`${API}/slices/${create.body.data.id}`)
        .set('Authorization', manager.auth)
        .expect(403);
    });

    it('blocks deleting a department that has slices', async () => {
      await request(app).post(`${API}/slices`).set('Authorization', manager.auth).send(sliceBody()).expect(201);

      const res = await request(app)
        .delete(`${API}/departments/${departmentId}`)
        .set('Authorization', admin.auth)
        .expect(409);
      expect(res.body.error.code).toBe(ErrorCode.RESOURCE_IN_USE);
    });
  });
});
