import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '@/config/env';
import { ErrorCode } from '@/constants/errorCodes';
import { createTestHarness, type TestHarness } from '../helpers/testApp';

describe('HTTP kernel', () => {
  let harness: TestHarness;
  let app: Express;

  beforeAll(async () => {
    harness = await createTestHarness();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.dispose();
  });

  describe('health endpoints', () => {
    it('reports liveness without touching dependencies', async () => {
      const res = await request(app).get('/health/live').expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('up');
      expect(typeof res.body.data.uptimeSeconds).toBe('number');
    });

    it('aggregates registered readiness probes', async () => {
      const res = await request(app).get('/health/ready').expect(200);

      expect(res.body.data.checks).toHaveProperty('process');
      expect(res.body.data.checks.process.status).toBe('up');
      expect(res.body.data.checks).toHaveProperty('datastore');
      expect(res.body.data.checks.datastore.status).toBe('up');
    });

    it('reports degraded while telemetry has not yet produced a snapshot', async () => {
      // The harness runs headless, so no telemetry tick has fired. A platform that has
      // never observed the network must not claim to be ready to arbitrate it — but it is
      // still serving requests, so `degraded` (not `down`) is the correct answer and the
      // instance stays in rotation.
      const res = await request(app).get('/health/ready').expect(200);

      expect(res.body.data.status).toBe('degraded');
      expect(res.body.data.checks.telemetry.status).toBe('degraded');
      expect(res.body.data.checks.telemetry.message).toContain('no telemetry snapshot');
    });

    it('returns 503 when a critical probe reports down', async () => {
      harness.container.health.register('flaky-dependency', () => ({
        status: 'down',
        message: 'simulated outage',
      }));

      const res = await request(app).get('/health/ready').expect(503);
      expect(res.body.data.status).toBe('down');
      expect(res.body.data.checks['flaky-dependency'].message).toBe('simulated outage');

      harness.container.health.unregister('flaky-dependency');
    });

    it('degrades rather than downs the service for a non-critical probe', async () => {
      harness.container.health.register(
        'optional-dependency',
        () => ({ status: 'down', message: 'slack webhook unreachable' }),
        { critical: false },
      );

      const res = await request(app).get('/health/ready').expect(200);
      expect(res.body.data.status).toBe('degraded');
      expect(res.body.data.checks['optional-dependency'].status).toBe('down');

      harness.container.health.unregister('optional-dependency');
    });

    it('contains a failing probe rather than letting it reject the whole report', async () => {
      harness.container.health.register('throwing-probe', () => {
        throw new Error('boom');
      });

      const res = await request(app).get('/health/ready').expect(503);
      expect(res.body.data.checks['throwing-probe'].status).toBe('down');
      expect(res.body.data.checks['throwing-probe'].message).toBe('boom');
      expect(res.body.data.checks.process.status).toBe('up');

      harness.container.health.unregister('throwing-probe');
    });

    it('exposes the active adapter wiring on /health/info', async () => {
      const res = await request(app).get('/health/info').expect(200);
      expect(res.body.data.adapters).toEqual({
        datastore: env.DATASTORE_DRIVER,
        auth: env.AUTH_DRIVER,
        telemetry: env.TELEMETRY_PROVIDER,
      });
      expect(res.body.data.network.offeredCapacityMbps).toBe(
        env.NETWORK_TOTAL_CAPACITY_MBPS - env.NETWORK_RESERVED_CAPACITY_MBPS,
      );
    });
  });

  describe('correlation ids', () => {
    it('generates one and echoes it in the response header', async () => {
      const res = await request(app).get('/health/live').expect(200);
      const header = res.headers['x-correlation-id'];
      expect(header).toBeTruthy();
      expect(res.body.meta.correlationId).toBe(header);
    });

    it('propagates a caller-supplied correlation id', async () => {
      const res = await request(app)
        .get('/health/live')
        .set('X-Correlation-Id', 'trace-abc-123')
        .expect(200);
      expect(res.headers['x-correlation-id']).toBe('trace-abc-123');
    });

    it('rejects an unsafe inbound correlation id and generates its own', async () => {
      // Header injection guard: a value containing CRLF or exceeding the length bound is
      // discarded rather than reflected into the response headers.
      const res = await request(app)
        .get('/health/live')
        .set('X-Correlation-Id', 'bad value with spaces')
        .expect(200);
      expect(res.headers['x-correlation-id']).not.toBe('bad value with spaces');
    });
  });

  describe('error envelope', () => {
    it('returns a structured 404 for an unknown route', async () => {
      const res = await request(app).get('/api/v1/does-not-exist').expect(404);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: ErrorCode.NOT_FOUND },
      });
      expect(res.body.error.correlationId).toBeTruthy();
      expect(res.body.error.timestamp).toBeTruthy();
    });

    it('returns MALFORMED_REQUEST for unparseable JSON', async () => {
      const res = await request(app)
        .post(`${env.API_PREFIX}/anything`)
        .set('Content-Type', 'application/json')
        .send('{"unclosed": ')
        .expect(400);
      expect(res.body.error.code).toBe(ErrorCode.MALFORMED_REQUEST);
    });
  });

  describe('security posture', () => {
    it('does not advertise the server technology', async () => {
      const res = await request(app).get('/health/live');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('sets helmet security headers', async () => {
      const res = await request(app).get('/health/live');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    });

    it('permits an allow-listed origin', async () => {
      const origin = env.CORS_ORIGINS[0]!;
      const res = await request(app).get('/health/live').set('Origin', origin).expect(200);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    });

    it('rejects an origin outside the allow-list through the error envelope', async () => {
      const res = await request(app)
        .get('/health/live')
        .set('Origin', 'https://evil.example.com')
        .expect(403);
      expect(res.body.error.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('allows requests with no Origin header (server-to-server, curl)', async () => {
      await request(app).get('/health/live').expect(200);
    });
  });

  describe('API discovery document', () => {
    it('describes the service at the API root', async () => {
      const res = await request(app).get(env.API_PREFIX).expect(200);
      expect(res.body.data.apiVersion).toBe('v1');
      expect(res.body.data.prefix).toBe(env.API_PREFIX);
    });
  });

  describe('response envelope', () => {
    it('attaches correlation, timestamp and duration metadata to every success', async () => {
      const res = await request(app).get('/health/live').expect(200);
      expect(res.body.meta).toMatchObject({
        correlationId: expect.any(String),
        timestamp: expect.any(String),
        durationMs: expect.any(Number),
      });
      expect(res.body.meta.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
