import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import { GatewayTelemetryAdapter } from '@/telemetry/adapters/gateway.telemetry.adapter';
import { HealthState } from '@/constants/enums';
import type { TelemetrySampleRequest } from '@/interfaces/telemetry.port';

describe('GatewayTelemetryAdapter Unit Tests', () => {
  const fakePort = 9988;
  const fakeToken = 'secret-test-token';
  let server: http.Server;
  let adapter: GatewayTelemetryAdapter;

  let mockStatsHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let mockLimitHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | undefined;

  beforeEach(async () => {
    adapter = new GatewayTelemetryAdapter({
      baseUrl: `http://127.0.0.1:${fakePort}`,
      token: fakeToken,
      timeoutMs: 1000,
    });

    adapter.registerSlaTargets('slice-clinic', {
      maxLatencyMs: 150,
      maxJitterMs: 25,
      maxPacketLossPercent: 0.1,
      minThroughputMbps: 40,
      availabilityPercent: 99.999,
    });

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        if (req.headers.authorization !== `Bearer ${fakeToken}`) {
          res.statusCode = 401;
          return res.end('Unauthorized');
        }

        if (req.url === '/v1/stats' && req.method === 'GET') {
          if (mockStatsHandler) {
            return mockStatsHandler(req, res);
          }
          res.setHeader('Content-Type', 'application/json');
          return res.end(
            JSON.stringify([
              {
                code: 'slice-clinic',
                atMs: Date.now(),
                demandKbps: 60,
                limitKbps: 60,
                usedKbps: 60,
                droppedKbps: 0,
                queueMs: 5,
                latencyP50Ms: 15,
                latencyP95Ms: 25,
                jitterMs: 2,
                lossPct: 0.005,
                availabilityPct: 100,
                activeDevices: 1,
                activeSessions: 1,
                saturated: false,
              },
            ])
          );
        }

        if (req.url?.startsWith('/v1/slices/') && req.method === 'PUT') {
          if (mockLimitHandler) {
            return mockLimitHandler(req, res);
          }
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const parsed = JSON.parse(body);
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ applied: true, effectiveKbps: parsed.limitKbps }));
          });
          return;
        }

        if (req.url === '/v1/capacity') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(
            JSON.stringify({
              totalKbps: 1000,
              reservedKbps: 50,
              offeredKbps: 950,
            })
          );
        }

        if (req.url === '/v1/health') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ ok: true }));
        }

        res.statusCode = 404;
        res.end();
      });

      server.listen(fakePort, '127.0.0.1', () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('correctly maps gateway stats to SliceTelemetry', async () => {
    const req: TelemetrySampleRequest = {
      atMs: Date.now(),
      subjects: [
        {
          sliceId: 'slice-clinic',
          code: 'slice-clinic',
          snssai: { sst: 2, sd: '000101' },
          allocatedMbps: 60,
          baselineAllocatedMbps: 60,
          minGuaranteedMbps: 40,
          maxBurstMbps: 90,
          profile: 'URLLC',
        },
      ],
    };

    const telemetry = await adapter.sample(req);
    expect(telemetry.length).toBe(1);
    const item = telemetry[0]!;

    expect(item.sliceId).toBe('slice-clinic');
    expect(item.demandMbps).toBe(60);
    expect(item.usedMbps).toBe(60);
    expect(item.allocatedMbps).toBe(60);
    expect(item.latencyMs).toBe(25);
    expect(item.jitterMs).toBe(2);
    expect(item.packetLossPercent).toBe(0.005);
    expect(item.health).toBe(HealthState.HEALTHY);
    expect(item.healthScore).toBeGreaterThan(80);
  });

  it('implements UNKNOWN-on-missing contract when slice is not reported by gateway', async () => {
    mockStatsHandler = (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([])); // empty stats from gateway
    };

    const req: TelemetrySampleRequest = {
      atMs: Date.now(),
      subjects: [
        {
          sliceId: 'slice-clinic',
          code: 'slice-clinic',
          snssai: { sst: 2, sd: '000101' },
          allocatedMbps: 60,
          baselineAllocatedMbps: 60,
          minGuaranteedMbps: 40,
          maxBurstMbps: 90,
          profile: 'URLLC',
        },
      ],
    };

    const telemetry = await adapter.sample(req);
    expect(telemetry.length).toBe(1);
    expect(telemetry[0]!.health).toBe(HealthState.UNKNOWN);
    expect(telemetry[0]!.healthScore).toBe(0);
  });

  it('handles gateway unreachable gracefully and returns UNKNOWN for all requested slices', async () => {
    // Point adapter to closed port
    const unreachableAdapter = new GatewayTelemetryAdapter({
      baseUrl: 'http://127.0.0.1:49999',
      token: fakeToken,
      timeoutMs: 200,
    });

    const req: TelemetrySampleRequest = {
      atMs: Date.now(),
      subjects: [
        {
          sliceId: 'slice-clinic',
          code: 'slice-clinic',
          snssai: { sst: 2, sd: '000101' },
          allocatedMbps: 60,
          baselineAllocatedMbps: 60,
          minGuaranteedMbps: 40,
          maxBurstMbps: 90,
          profile: 'URLLC',
        },
      ],
    };

    const telemetry = await unreachableAdapter.sample(req);
    expect(telemetry.length).toBe(1);
    expect(telemetry[0]!.health).toBe(HealthState.UNKNOWN);
  });

  it('applyAllocation sends idempotent PUT requests to gateway', async () => {
    const results = await adapter.applyAllocation([
      {
        sliceId: 'slice-clinic',
        code: 'slice-clinic',
        snssai: { sst: 2, sd: '000101' },
        targetMbps: 50,
        previousMbps: 60,
        decisionId: 'dec-123',
        reason: 'Contention alleviation',
      },
    ]);

    expect(results.length).toBe(1);
    expect(results[0]!.applied).toBe(true);
    expect(results[0]!.effectiveMbps).toBe(50);
  });

  it('rejects /telemetry/load with 409 Conflict in gateway mode', async () => {
    const { createTelemetryController } = await import('@/controllers/telemetry.controller');
    const { ConflictError } = await import('@/utils/errors');

    const fakeTelemetryService: any = {
      networkProvider: adapter,
    };

    const controller = createTelemetryController({
      telemetry: fakeTelemetryService,
      repository: {} as any,
      clock: { now: () => Date.now(), sleep: async () => {} } as any,
    });

    const mockReq: any = { body: { multiplier: 2 } };
    const mockRes: any = { json: vi.fn(), status: vi.fn() };
    const mockNext = vi.fn();

    await controller.setLoad(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    const error = mockNext.mock.calls[0]![0];
    expect(error).toBeInstanceOf(ConflictError);
  });
});
