import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '@/config/env';
import { UserRole } from '@/constants/enums';
import { buildOpenApiDocument } from '@/docs/openapi';
import { createTestHarness, type SignedInUser, type TestHarness } from '../helpers/testApp';

const API = env.API_PREFIX;

describe('API surface, settings and reports', () => {
  let harness: TestHarness;
  let app: Express;
  let admin: SignedInUser;
  let manager: SignedInUser;
  let viewer: SignedInUser;

  beforeAll(async () => {
    harness = await createTestHarness();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    await harness.reset();
    admin = await harness.signInAs(UserRole.ADMIN, 'api-admin@corp.example');
    manager = await harness.signInAs(UserRole.MANAGER, 'api-manager@corp.example');
    viewer = await harness.signInAs(UserRole.VIEWER, 'api-viewer@corp.example');
  });

  /* ================================================================== */
  describe('service discovery', () => {
    it('advertises every mounted resource', async () => {
      const res = await request(app).get(API).expect(200);

      expect(res.body.data.resources).toEqual(
        expect.arrayContaining([
          'auth',
          'users',
          'departments',
          'policies',
          'slices',
          'telemetry',
          'capacity',
          'contention',
          'arbitration',
          'audit',
          'notifications',
          'settings',
          'reports',
        ]),
      );
    });
  });

  /* ================================================================== */
  describe('OpenAPI document', () => {
    it('is a valid 3.1 document with the expected structure', () => {
      const doc = buildOpenApiDocument() as {
        openapi: string;
        info: { title: string };
        paths: Record<string, unknown>;
        components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
      };

      expect(doc.openapi).toBe('3.1.0');
      expect(doc.info.title).toContain('Runtime Arbitration');
      expect(Object.keys(doc.paths).length).toBeGreaterThan(10);
      expect(doc.components.securitySchemes).toHaveProperty('bearerAuth');
    });

    it('documents the schemas an integrator needs', () => {
      const doc = buildOpenApiDocument() as { components: { schemas: Record<string, unknown> } };
      const schemas = Object.keys(doc.components.schemas);

      expect(schemas).toEqual(
        expect.arrayContaining([
          'ApiSuccess',
          'ApiError',
          'Department',
          'Slice',
          'ArbitrationDecision',
          'DecisionAllocation',
          'DecisionAlternative',
          'NetworkSnapshot',
        ]),
      );
    });

    it('states that the slice profile is never read by arbitration', () => {
      // The documentation must carry the platform's central claim, or an integrator will
      // reasonably assume `profile` influences ranking as it does in every other system
      // they have used.
      const doc = buildOpenApiDocument() as {
        components: { schemas: { Slice: { properties: { profile: { description: string } } } } };
      };

      expect(doc.components.schemas.Slice.properties.profile.description).toContain('NEVER');
    });

    it('is served alongside the UI', async () => {
      const res = await request(app).get(`${env.SWAGGER_PATH}/openapi.json`).expect(200);
      expect(res.body.openapi).toBe('3.1.0');
      expect(res.body.paths).toBeDefined();
    });
  });

  /* ================================================================== */
  describe('settings', () => {
    it('seeds defaults on first read', async () => {
      const res = await request(app)
        .get(`${API}/settings`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.autoArbitrationEnabled).toBe(true);
      expect(res.body.data.maintenanceMode).toBe(false);
      expect(res.body.data.dashboard.defaultTheme).toBe('dark');
      expect(res.body.data.currencyCode).toBe('USD');
    });

    it('merges a nested patch rather than replacing the group', async () => {
      const before = await request(app)
        .get(`${API}/settings`)
        .set('Authorization', viewer.auth)
        .expect(200);

      const res = await request(app)
        .patch(`${API}/settings`)
        .set('Authorization', admin.auth)
        .send({ dashboard: { defaultTheme: 'light' } })
        .expect(200);

      expect(res.body.data.dashboard.defaultTheme).toBe('light');
      // Untouched siblings must survive.
      expect(res.body.data.dashboard.pollIntervalMs).toBe(before.body.data.dashboard.pollIntervalMs);
      expect(res.body.data.dashboard.chartWindowPoints).toBe(
        before.body.data.dashboard.chartWindowPoints,
      );
    });

    it('suspends the live control loop when maintenance mode is enabled', async () => {
      // The switch must take effect on the next tick, not at the next deployment.
      harness.container.autoArbitration.enabled = true;

      await request(app)
        .patch(`${API}/settings`)
        .set('Authorization', admin.auth)
        .send({ maintenanceMode: true, maintenanceReason: 'Planned transport upgrade' })
        .expect(200);

      expect(harness.container.autoArbitration.enabled).toBe(false);

      await request(app)
        .patch(`${API}/settings`)
        .set('Authorization', admin.auth)
        .send({ maintenanceMode: false })
        .expect(200);

      expect(harness.container.autoArbitration.enabled).toBe(true);
    });

    it('denies settings writes to MANAGER', async () => {
      await request(app)
        .patch(`${API}/settings`)
        .set('Authorization', manager.auth)
        .send({ maintenanceMode: true })
        .expect(403);
    });

    it('rejects an empty patch', async () => {
      await request(app)
        .patch(`${API}/settings`)
        .set('Authorization', admin.auth)
        .send({})
        .expect(400);
    });

    it('audits a settings change with a readable summary', async () => {
      await request(app)
        .patch(`${API}/settings`)
        .set('Authorization', admin.auth)
        .send({ autoArbitrationEnabled: false })
        .expect(200);

      const entries = await harness.container.services.audit.timelineFor('global');
      const change = entries.find((e) => e.action === 'SETTINGS_UPDATED');

      expect(change).toBeDefined();
      expect(change!.summary).toContain('automatic arbitration SUSPENDED');
      expect(change!.actor.userId).toBe(admin.userId);
    });
  });

  /* ================================================================== */
  describe('system status', () => {
    it('reports the active adapter wiring and control-loop state', async () => {
      const res = await request(app)
        .get(`${API}/settings/system`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.adapters.datastore).toBe(env.DATASTORE_DRIVER);
      expect(res.body.data.adapters.telemetry).toBe('synthetic');
      expect(res.body.data.adapters.telemetryCapabilities.enforcement).toBe(true);
      expect(res.body.data.network.offeredCapacityMbps).toBe(
        env.NETWORK_TOTAL_CAPACITY_MBPS - env.NETWORK_RESERVED_CAPACITY_MBPS,
      );
      expect(res.body.data.controlLoop).toHaveProperty('autoArbitration');
      expect(Array.isArray(res.body.data.jobs)).toBe(true);
    });

    it('exposes registered jobs and their statistics', async () => {
      const res = await request(app)
        .get(`${API}/settings/system`)
        .set('Authorization', viewer.auth)
        .expect(200);

      const names = (res.body.data.jobs as { name: string }[]).map((j) => j.name);
      expect(names).toEqual(
        expect.arrayContaining(['telemetry-tick', 'recovery-sweep', 'telemetry-retention']),
      );
    });
  });

  /* ================================================================== */
  describe('reports', () => {
    it('leads with the harm avoided versus a conventional priority sort', async () => {
      // The platform's whole justification over a QoS controller, as the first figure on
      // the page rather than an assertion in a slide deck.
      const res = await request(app)
        .get(`${API}/reports/overview`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.headline).toHaveProperty('harmAvoidedVsPrioritySortPercent');
      expect(res.body.data.headline).toHaveProperty('arbitrationRuns');
      expect(res.body.data.headline).toHaveProperty('bandwidthFreedMbps');
      expect(res.body.data.headline).toHaveProperty('meanConfidence');
    });

    it('includes admission headroom and per-department shares', async () => {
      const res = await request(app)
        .get(`${API}/reports/overview`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.admission.offeredCapacityMbps).toBeGreaterThan(0);
      expect(Array.isArray(res.body.data.departments)).toBe(true);
    });

    it('requires authentication', async () => {
      await request(app).get(`${API}/reports/overview`).expect(401);
    });
  });

  /* ================================================================== */
  describe('realtime gateway', () => {
    it('is constructed but not attached in headless mode', () => {
      const stats = harness.container.realtime.stats();
      expect(stats.enabled).toBe(false);
      expect(stats.connections).toBe(0);
    });
  });
});
