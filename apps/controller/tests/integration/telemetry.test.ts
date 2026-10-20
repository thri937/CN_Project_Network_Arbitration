import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '@/config/env';
import { ErrorCode } from '@/constants/errorCodes';
import {
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  HealthState,
  RecoveryTolerance,
  SliceProfile,
  UserRole,
} from '@/constants/enums';
import { isSyntheticProvider } from '@/telemetry';
import { createTestHarness, type SignedInUser, type TestHarness } from '../helpers/testApp';

const API = env.API_PREFIX;

describe('telemetry service & control loop', () => {
  let harness: TestHarness;
  let app: Express;
  let manager: SignedInUser;
  let viewer: SignedInUser;
  let departmentId: string;
  let sliceId: string;

  const collect = () => harness.container.services.telemetry.collect();

  beforeAll(async () => {
    harness = await createTestHarness();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    await harness.reset();
    manager = await harness.signInAs(UserRole.MANAGER, 'tlm-manager@corp.example');
    viewer = await harness.signInAs(UserRole.VIEWER, 'tlm-viewer@corp.example');

    const dept = await request(app)
      .post(`${API}/departments`)
      .set('Authorization', manager.auth)
      .send({
        name: 'Manufacturing',
        criticality: DepartmentCriticality.MISSION_CRITICAL,
        businessImportance: 90,
        downtimeCostPerMinute: 8000,
        recoveryTolerance: RecoveryTolerance.LOW,
        maxAllowedDegradationPercent: 30,
        complianceLevel: ComplianceLevel.CONTRACTUAL,
        customerImpact: CustomerImpact.DIRECT,
        operationalImportance: 85,
      })
      .expect(201);
    departmentId = dept.body.data.id;

    const slice = await request(app)
      .post(`${API}/slices`)
      .set('Authorization', manager.auth)
      .send({
        name: 'Plant Automation',
        departmentId,
        snssai: { sst: 2, sd: '0000A1' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: 1000,
        minGuaranteedMbps: 400,
        maxBurstMbps: 1500,
        slaTargets: {
          maxLatencyMs: 20,
          maxJitterMs: 5,
          maxPacketLossPercent: 0.5,
          minThroughputMbps: 200,
          availabilityPercent: 99.99,
        },
      })
      .expect(201);
    sliceId = slice.body.data.id;
  });

  /* ================================================================== */
  describe('collection cycle', () => {
    it('produces a snapshot covering every arbitrable slice', async () => {
      const snapshot = await collect();

      expect(snapshot).not.toBeNull();
      expect(snapshot!.slices).toHaveLength(1);
      expect(snapshot!.slices[0]!.sliceId).toBe(sliceId);
      expect(snapshot!.slices[0]!.departmentId).toBe(departmentId);
      expect(snapshot!.source).toBe('synthetic');
      expect(snapshot!.offeredCapacityMbps).toBeGreaterThan(0);
    });

    it('advances the tick counter and totals demand across the fleet', async () => {
      const first = await collect();
      const second = await collect();

      expect(second!.tick).toBe(first!.tick + 1);
      expect(second!.totalDemandMbps).toBeGreaterThan(0);
      expect(second!.totalAllocatedMbps).toBe(1000);
    });

    it('excludes paused slices from the snapshot', async () => {
      await request(app)
        .post(`${API}/slices/${sliceId}/pause`)
        .set('Authorization', manager.auth)
        .send({ reason: 'maintenance' })
        .expect(200);

      const snapshot = await collect();
      expect(snapshot!.slices).toHaveLength(0);
      expect(snapshot!.totalAllocatedMbps).toBe(0);
    });

    it('assesses health against the slice’s own SLA targets', async () => {
      const snapshot = await collect();
      const state = snapshot!.slices[0]!;

      expect(Object.values(HealthState)).toContain(state.health);
      expect(state.healthScore).toBeGreaterThanOrEqual(0);
      expect(state.healthScore).toBeLessThanOrEqual(100);
      expect(state.slaStress).toBeGreaterThanOrEqual(0);
      expect(state.slaStress).toBeLessThanOrEqual(1);
    });

    it('emits a snapshot event that downstream consumers can subscribe to', async () => {
      const received: number[] = [];
      const listener = (s: { tick: number }) => received.push(s.tick);

      harness.container.services.telemetry.on('snapshot', listener);
      await collect();
      await collect();
      harness.container.services.telemetry.off('snapshot', listener);

      expect(received).toHaveLength(2);
      expect(received[1]).toBe(received[0]! + 1);
    });
  });

  /* ================================================================== */
  describe('degradation is observable', () => {
    it('raises utilisation and loss when the allocation is cut', async () => {
      // The property the whole control loop rests on: applying a degradation must have
      // measurable consequences on the next sample, or the dashboard is fiction.
      const provider = harness.container.telemetryProvider;
      if (!isSyntheticProvider(provider)) throw new Error('expected the synthetic provider');

      // Settle at the baseline.
      for (let i = 0; i < 20; i += 1) await collect();
      const before = harness.container.services.telemetry.getSliceState(sliceId)!;

      // Cut the allocation hard, as arbitration would.
      await harness.container.repositories.slices.base.update(sliceId, { allocatedMbps: 100 });
      for (let i = 0; i < 10; i += 1) await collect();
      const after = harness.container.services.telemetry.getSliceState(sliceId)!;

      expect(after.allocatedMbps).toBe(100);
      expect(after.usedMbps).toBeLessThanOrEqual(100);
      expect(after.utilisation).toBeGreaterThan(before.utilisation);
      expect(after.packetLossPercent).toBeGreaterThan(before.packetLossPercent);
      expect(after.latencyMs).toBeGreaterThan(before.latencyMs);
    });

    it('leaves demand unchanged by a degradation', async () => {
      // Contention must PERSIST after mitigation. If demand collapsed to match the new
      // allocation, every contention event would erase its own evidence.
      for (let i = 0; i < 30; i += 1) await collect();
      const beforeDemand = harness.container.services.telemetry.getSliceState(sliceId)!.demandMbps;

      await harness.container.repositories.slices.base.update(sliceId, { allocatedMbps: 50 });
      for (let i = 0; i < 30; i += 1) await collect();
      const afterDemand = harness.container.services.telemetry.getSliceState(sliceId)!.demandMbps;

      // Demand wanders (it is a random walk) but must not collapse toward 50.
      expect(afterDemand).toBeGreaterThan(200);
      expect(Math.abs(afterDemand - beforeDemand) / beforeDemand).toBeLessThan(1.5);
    });
  });

  /* ================================================================== */
  describe('live endpoints', () => {
    it('serves the in-memory snapshot the control loop is acting on', async () => {
      await collect();

      const res = await request(app)
        .get(`${API}/telemetry/live`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.snapshot.slices).toHaveLength(1);
      expect(res.body.data.snapshotAgeMs).toBeGreaterThanOrEqual(0);
      expect(res.body.data.stale).toBe(false);
    });

    it('flags a missing snapshot as stale rather than pretending', async () => {
      const res = await request(app)
        .get(`${API}/telemetry/live`)
        .set('Authorization', viewer.auth)
        .expect(200);

      // `reset()` cleared the snapshot; the UI must show "stale", not old numbers.
      expect(res.body.data.stale).toBe(true);
    });

    it('serves a single slice’s live state', async () => {
      await collect();

      const res = await request(app)
        .get(`${API}/telemetry/live/${sliceId}`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.sliceId).toBe(sliceId);
      expect(res.body.data.sliceCode).toBe('plant-automation');
    });

    it('404s for a slice with no live state', async () => {
      await collect();
      await request(app)
        .get(`${API}/telemetry/live/SLC-NOPE`)
        .set('Authorization', viewer.auth)
        .expect(404);
    });

    it('reports the active provider and its capabilities', async () => {
      const res = await request(app)
        .get(`${API}/telemetry/provider`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.name).toBe('synthetic');
      expect(res.body.data.capabilities.enforcement).toBe(true);
      expect(res.body.data.capacity.offeredMbps).toBe(
        env.NETWORK_TOTAL_CAPACITY_MBPS - env.NETWORK_RESERVED_CAPACITY_MBPS,
      );
      expect(res.body.data.simulation).toBeDefined();
    });
  });

  /* ================================================================== */
  describe('persistence', () => {
    it('persists a throttled subset of samples', async () => {
      const every = env.TELEMETRY_PERSIST_EVERY_N_TICKS;
      for (let i = 0; i < every * 3; i += 1) await collect();

      const res = await request(app)
        .get(`${API}/telemetry`)
        .set('Authorization', viewer.auth)
        .query({ sliceId, limit: 100 })
        .expect(200);

      // Throttled: 3 writes for 3N ticks, not 3N writes.
      expect(res.body.data.length).toBe(3);
      expect(res.body.data[0].sliceId).toBe(sliceId);
      expect(res.body.data[0].source).toBe('synthetic');
    });

    it('serves a chart-ready series ordered oldest first', async () => {
      for (let i = 0; i < env.TELEMETRY_PERSIST_EVERY_N_TICKS * 4; i += 1) await collect();

      const res = await request(app)
        .get(`${API}/telemetry/series/${sliceId}`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.points).toBeGreaterThan(0);
      const timestamps = res.body.data.samples.map((s: { atMs: number }) => s.atMs);
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    });
  });

  /* ================================================================== */
  describe('fault injection', () => {
    it('drives demand up during a surge', async () => {
      for (let i = 0; i < 20; i += 1) await collect();
      const baseline = harness.container.services.telemetry.getSliceState(sliceId)!.demandMbps;

      await request(app)
        .post(`${API}/telemetry/faults`)
        .set('Authorization', manager.auth)
        .send({ sliceId, kind: 'DEMAND_SURGE', durationTicks: 40 })
        .expect(200);

      let peak = 0;
      for (let i = 0; i < 25; i += 1) {
        await collect();
        peak = Math.max(peak, harness.container.services.telemetry.getSliceState(sliceId)!.demandMbps);
      }

      expect(peak).toBeGreaterThan(baseline * 1.4);
    });

    it('scales demand fleet-wide via the global load control', async () => {
      for (let i = 0; i < 20; i += 1) await collect();
      const before = harness.container.services.telemetry.getSnapshot()!.totalDemandMbps;

      await request(app)
        .post(`${API}/telemetry/load`)
        .set('Authorization', manager.auth)
        .send({ multiplier: 3 })
        .expect(200);

      for (let i = 0; i < 15; i += 1) await collect();
      const after = harness.container.services.telemetry.getSnapshot()!.totalDemandMbps;

      expect(after).toBeGreaterThan(before * 1.8);

      // Restore, so a later test in the file is not affected.
      await request(app)
        .post(`${API}/telemetry/load`)
        .set('Authorization', manager.auth)
        .send({ multiplier: 1 })
        .expect(200);
    });

    it('404s when injecting into a slice the simulation has not seen', async () => {
      await collect();
      await request(app)
        .post(`${API}/telemetry/faults`)
        .set('Authorization', manager.auth)
        .send({ sliceId: 'SLC-UNKNOWN', kind: 'DEMAND_SURGE', durationTicks: 10 })
        .expect(404);
    });

    it('denies fault injection to VIEWER', async () => {
      // The consequences inside the platform are indistinguishable from real congestion.
      await collect();
      const res = await request(app)
        .post(`${API}/telemetry/faults`)
        .set('Authorization', viewer.auth)
        .send({ sliceId, kind: 'DEMAND_SURGE', durationTicks: 10 })
        .expect(403);
      expect(res.body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
    });

    it('rejects an out-of-range load multiplier', async () => {
      await request(app)
        .post(`${API}/telemetry/load`)
        .set('Authorization', manager.auth)
        .send({ multiplier: 500 })
        .expect(400);
    });
  });

  /* ================================================================== */
  describe('health probe', () => {
    it('reports degraded before the first collection', () => {
      const probe = harness.container.services.telemetry.healthProbe();
      expect(probe.status).toBe('degraded');
      expect(probe.message).toContain('no telemetry snapshot');
    });

    it('reports up immediately after a collection', async () => {
      await collect();
      expect(harness.container.services.telemetry.healthProbe().status).toBe('up');
    });

    it('reports DOWN when the loop has stalled', async () => {
      // A stalled loop is the platform's most dangerous failure: arbitration would keep
      // acting on a frozen view of the network.
      await collect();
      harness.clock.advance(env.TELEMETRY_TICK_MS * 10);

      const probe = harness.container.services.telemetry.healthProbe();
      expect(probe.status).toBe('down');
      expect(probe.message).toContain('stale data');
    });
  });
});
