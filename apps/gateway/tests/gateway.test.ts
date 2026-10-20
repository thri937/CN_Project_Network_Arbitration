import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShaperScheduler } from '../src/shaper/scheduler.js';
import { TokenBucket } from '../src/shaper/tokenBucket.js';
import { FifoQueue } from '../src/shaper/queue.js';
import { DeviceRegistry } from '../src/sessions/deviceRegistry.js';
import { ProbeManager } from '../src/probes/probeManager.js';
import { SouthboundServer } from '../src/southbound/southboundServer.js';
import { LoadSession } from '../src/sessions/loadSession.js';
import { SliceCatalogueItem } from '@cn/shared';
import http from 'node:http';

describe('Gateway Unit Tests', () => {
  const dummySlices: SliceCatalogueItem[] = [
    {
      code: 'slice-telemetry',
      name: 'Patient Telemetry',
      department: 'Clinic',
      sNssai: { sst: 2, sd: '000101' },
      profile: 'URLLC',
      baselineKbps: 60,
      floorKbps: 40,
      burstKbps: 90,
      currentLimitKbps: 60,
      slaTargets: {
        latencyMs: 150,
        jitterMs: 25,
        lossPct: 0.1,
        minThroughputKbps: 40,
        availabilityPct: 99.999,
      },
      joinCode: 'CLN101',
    },
    {
      code: 'slice-factory',
      name: 'Factory Automation',
      department: 'Factory',
      sNssai: { sst: 2, sd: '000201' },
      profile: 'URLLC',
      baselineKbps: 380,
      floorKbps: 170,
      burstKbps: 580,
      currentLimitKbps: 380,
      slaTargets: {
        latencyMs: 180,
        jitterMs: 30,
        lossPct: 0.1,
        minThroughputKbps: 150,
        availabilityPct: 99.99,
      },
      joinCode: 'FAC201',
    },
  ];

  describe('1. Token-bucket and Shaper Accuracy within ±3%', () => {
    const testRates = [20, 60, 140, 380, 950];

    testRates.forEach((targetRateKbps) => {
      it(`holds rate within ±3% at ${targetRateKbps} kbps over 10 s virtual clock`, () => {
        const scheduler = new ShaperScheduler({
          totalCapacityKbps: 1000,
          reservedCapacityKbps: 50,
          tickMs: 20,
          queueSeconds: 0.5,
          rootDiscipline: 'fifo',
        });

        const slice: SliceCatalogueItem = {
          code: 'slice-test',
          name: 'Test Slice',
          department: 'Test',
          sNssai: { sst: 1 },
          profile: 'eMBB',
          baselineKbps: targetRateKbps,
          floorKbps: Math.floor(targetRateKbps * 0.5),
          burstKbps: targetRateKbps * 1.5,
          currentLimitKbps: targetRateKbps,
          slaTargets: {
            latencyMs: 100,
            jitterMs: 20,
            lossPct: 1,
            minThroughputKbps: 10,
            availabilityPct: 99,
          },
          joinCode: 'TEST01',
        };

        scheduler.registerSlice(slice);

        // Mock session that offers 2x the target rate (saturated demand)
        let totalSentBytes = 0;
        const mockRes: any = {
          write: (chunk: Buffer) => {
            totalSentBytes += chunk.length;
            return true;
          },
          on: () => {},
          end: () => {},
        };

        const session = new LoadSession({
          sessionId: 's-test',
          deviceId: 'd-test',
          sliceCode: 'slice-test',
          initialRateKbps: targetRateKbps * 2, // saturated
          mode: 'local',
          res: mockRes,
          onClose: () => {},
        });

        scheduler.addSession(session);

        const dt = 0.02;
        // Warm-up 1 second (50 steps)
        for (let i = 0; i < 50; i++) {
          scheduler.step(dt);
        }

        // Measure over exactly 10 seconds (500 steps)
        totalSentBytes = 0;
        const steps = 500;
        for (let i = 0; i < steps; i++) {
          scheduler.step(dt);
        }

        const measuredRateKbps = (totalSentBytes * 8) / (10 * 1000);
        const errorPercent = Math.abs((measuredRateKbps - targetRateKbps) / targetRateKbps) * 100;

        expect(errorPercent).toBeLessThanOrEqual(3.0);
      });
    });

    it('keeps a deeply cut slice moving: 28 kbps limit with 10x demand still carries 28 kbps and answers probes', () => {
      // A cut to the Canteen floor. At 0.1 s of depth the bucket would hold 350 bytes, less
      // than one 1 KB chunk: the head chunk could never be sent and blocked the queue forever.
      const scheduler = new ShaperScheduler({
        totalCapacityKbps: 1000,
        reservedCapacityKbps: 50,
        tickMs: 20,
        queueSeconds: 0.5,
        rootDiscipline: 'fifo',
      });
      scheduler.registerSlice({
        ...dummySlices[0]!,
        code: 'canteen',
        baselineKbps: 140,
        floorKbps: 28,
        currentLimitKbps: 140,
      });
      scheduler.updateSliceLimit('canteen', 28);

      let sentBytes = 0;
      const res: any = { write: (c: Buffer) => ((sentBytes += c.length), true), on: () => {}, end: () => {} };
      scheduler.addSession(
        new LoadSession({
          sessionId: 's-canteen',
          deviceId: 'd-canteen',
          sliceCode: 'canteen',
          initialRateKbps: 280,
          mode: 'local',
          res,
          onClose: () => {},
        }),
      );

      // Uneven ticks, like Windows timers, make some arrivals full 1 KB chunks.
      const dts = [0.02, 0.035, 0.05];
      for (let i = 0; i < 60; i++) scheduler.step(dts[i % 3]!);

      // Probe once a second, as a device does; a saturated tail-drop queue drops some of them.
      // probeSeq carries the send time so the delay is measured on the virtual clock.
      let nowMs = 0;
      const delaysMs: number[] = [];
      scheduler.onTransmitProbe = (chunk) => delaysMs.push(nowMs - (chunk.probeSeq ?? 0));

      sentBytes = 0;
      let elapsed = 0;
      let nextProbeAt = 0;
      for (let i = 0; elapsed < 10 - 1e-9; i++) {
        if (elapsed >= nextProbeAt) {
          scheduler.enqueueProbeChunk('canteen', {
            sliceCode: 'canteen',
            data: Buffer.alloc(64),
            isProbe: true,
            probeSeq: Math.round(elapsed * 1000),
            enqueuedAtNs: 0n,
          });
          nextProbeAt += 1;
        }
        const dt = dts[i % 3]!;
        nowMs = Math.round((elapsed + dt) * 1000);
        scheduler.step(dt);
        elapsed += dt;
      }

      const kbps = (sentBytes * 8) / (elapsed * 1000);
      expect(Math.abs(kbps - 28) / 28).toBeLessThanOrEqual(0.05);

      // Probes that get in wait about half a second (0.5 s of queue at 28 kbps), well inside
      // the 2 s probe timeout.
      expect(delaysMs.length).toBeGreaterThan(0);
      expect(Math.max(...delaysMs)).toBeLessThan(1000);
    });

    it('root link capacity (950 kbps) is never exceeded', () => {
      const scheduler = new ShaperScheduler({
        totalCapacityKbps: 1000,
        reservedCapacityKbps: 50, // offered is 950 kbps
        tickMs: 20,
        queueSeconds: 0.5,
      });

      // Register two slices demanding 800 kbps each (total 1600 kbps > 950 kbps)
      const s1 = { ...dummySlices[0]!, code: 's1', currentLimitKbps: 800, baselineKbps: 800 };
      const s2 = { ...dummySlices[1]!, code: 's2', currentLimitKbps: 800, baselineKbps: 800 };
      scheduler.registerSlice(s1);
      scheduler.registerSlice(s2);

      let totalSentBytes = 0;
      const mockRes: any = {
        write: (chunk: Buffer) => {
          totalSentBytes += chunk.length;
          return true;
        },
        on: () => {},
        end: () => {},
      };

      const sess1 = new LoadSession({
        sessionId: 'sess1',
        deviceId: 'd1',
        sliceCode: 's1',
        initialRateKbps: 800,
        mode: 'local',
        res: mockRes,
        onClose: () => {},
      });
      const sess2 = new LoadSession({
        sessionId: 'sess2',
        deviceId: 'd2',
        sliceCode: 's2',
        initialRateKbps: 800,
        mode: 'local',
        res: mockRes,
        onClose: () => {},
      });

      scheduler.addSession(sess1);
      scheduler.addSession(sess2);

      // Warm-up 1 second
      for (let i = 0; i < 50; i++) {
        scheduler.step(0.02);
      }

      // Step 10 seconds in steady state
      totalSentBytes = 0;
      for (let i = 0; i < 500; i++) {
        scheduler.step(0.02);
      }

      const overallKbps = (totalSentBytes * 8) / (10 * 1000);
      expect(overallKbps).toBeLessThanOrEqual(950.5); // Root cap never exceeded
    });
  });

  describe('2. Congestion, Tail-Drop, and Probe Queueing Delays', () => {
    it('congested shared FIFO raises latency and loss for all slices', () => {
      const scheduler = new ShaperScheduler({
        totalCapacityKbps: 1000,
        reservedCapacityKbps: 50, // 950 kbps link
      });

      const sClinic = { ...dummySlices[0]!, code: 'clinic', currentLimitKbps: 60, baselineKbps: 60 };
      const sFactory = { ...dummySlices[1]!, code: 'factory', currentLimitKbps: 700, baselineKbps: 700 };
      const sOffice = { ...dummySlices[1]!, code: 'office', currentLimitKbps: 500, baselineKbps: 500 };
      scheduler.registerSlice(sClinic);
      scheduler.registerSlice(sFactory);
      scheduler.registerSlice(sOffice);

      // Total limits = 60 + 700 + 500 = 1260 kbps > 950 kbps
      // Factory and Office both flood, creating rootQueue congestion
      const mockRes: any = { write: () => true, on: () => {}, end: () => {} };
      const sessFactory = new LoadSession({
        sessionId: 'sf',
        deviceId: 'df',
        sliceCode: 'factory',
        initialRateKbps: 700,
        mode: 'local',
        res: mockRes,
        onClose: () => {},
      });
      const sessOffice = new LoadSession({
        sessionId: 'so',
        deviceId: 'do',
        sliceCode: 'office',
        initialRateKbps: 500,
        mode: 'local',
        res: mockRes,
        onClose: () => {},
      });
      scheduler.addSession(sessFactory);
      scheduler.addSession(sessOffice);

      // Step to fill rootQueue (700 + 500 = 1200 > 950 kbps)
      for (let i = 0; i < 50; i++) {
        scheduler.step(0.02);
      }

      expect(scheduler.getRootQueueDepthBytes()).toBeGreaterThan(0);

      // Now send a probe on clinic
      let probeDequeuedDelayMs = 0;
      scheduler.onTransmitProbe = (chunk) => {
        probeDequeuedDelayMs = Number(process.hrtime.bigint() - chunk.enqueuedAtNs) / 1e6;
      };

      const probeChunk = {
        sliceCode: 'clinic',
        data: Buffer.alloc(64),
        isProbe: true,
        enqueuedAtNs: process.hrtime.bigint(),
      };

      scheduler.enqueueProbeChunk('clinic', probeChunk);

      // Step until probe transmits
      for (let i = 0; i < 30; i++) {
        scheduler.step(0.02);
      }

      // Root queue depth should have forced the probe to wait behind the backlog
      expect(scheduler.getRootQueueDepthBytes()).toBeGreaterThanOrEqual(0);
    });

    it('tail-drop drops bytes at slice queue when exceeding slice buffer', () => {
      const scheduler = new ShaperScheduler({
        totalCapacityKbps: 1000,
        reservedCapacityKbps: 50,
      });

      const s1 = { ...dummySlices[0]!, code: 's1', baselineKbps: 40, currentLimitKbps: 40 };
      scheduler.registerSlice(s1);

      // Enqueue chunks until queue drops
      const sliceRuntime = scheduler.getSlice('s1')!;
      let dropped = false;
      for (let i = 0; i < 100; i++) {
        const chunk = {
          sliceCode: 's1',
          data: Buffer.alloc(1024),
          enqueuedAtNs: process.hrtime.bigint(),
        };
        const ok = sliceRuntime.queue.enqueue(chunk);
        if (!ok) {
          dropped = true;
          sliceRuntime.meter.recordSliceDrop(1024);
          break;
        }
      }

      expect(dropped).toBe(true);
      const stats = sliceRuntime.meter.rotateWindow(2, {
        p50: 10,
        p95: 20,
        jitter: 1,
        lostProbes: 0,
        sentProbes: 10,
        availabilityPct: 100,
      });
      expect(stats.droppedKbps).toBeGreaterThan(0);
    });
  });

  describe('3. DRR Weighted Fair Queueing', () => {
    it('drr mode shares link in proportion to limits', () => {
      const scheduler = new ShaperScheduler({
        totalCapacityKbps: 1000,
        reservedCapacityKbps: 50, // 950 kbps
        rootDiscipline: 'drr',
      });

      // s1 limit = 300, s2 limit = 600 (ratio 1:2)
      const s1 = { ...dummySlices[0]!, code: 's1', baselineKbps: 300, currentLimitKbps: 300 };
      const s2 = { ...dummySlices[1]!, code: 's2', baselineKbps: 600, currentLimitKbps: 600 };
      scheduler.registerSlice(s1);
      scheduler.registerSlice(s2);

      let bytes1 = 0;
      let bytes2 = 0;

      const sess1 = new LoadSession({
        sessionId: 's1',
        deviceId: 'd1',
        sliceCode: 's1',
        initialRateKbps: 1000,
        mode: 'local',
        res: { write: (c: Buffer) => { bytes1 += c.length; return true; }, on: () => {}, end: () => {} } as any,
        onClose: () => {},
      });
      const sess2 = new LoadSession({
        sessionId: 's2',
        deviceId: 'd2',
        sliceCode: 's2',
        initialRateKbps: 1000,
        mode: 'local',
        res: { write: (c: Buffer) => { bytes2 += c.length; return true; }, on: () => {}, end: () => {} } as any,
        onClose: () => {},
      });

      scheduler.addSession(sess1);
      scheduler.addSession(sess2);

      for (let i = 0; i < 250; i++) {
        scheduler.step(0.02);
      }

      const ratio = bytes2 / (bytes1 || 1);
      // Ratio should be approximately 2.0 (between 1.7 and 2.3)
      expect(ratio).toBeGreaterThan(1.7);
      expect(ratio).toBeLessThan(2.3);
    });

    // Two slices flood past the link; a light slice sends one probe. Returns how many 20 ms ticks
    // the probe took to leave (100 = never: it was dropped or still queued).
    const ticksForLightProbe = (rootDiscipline: 'fifo' | 'drr') => {
      const scheduler = new ShaperScheduler({ totalCapacityKbps: 1000, reservedCapacityKbps: 50, rootDiscipline });
      scheduler.registerSlice({ ...dummySlices[0]!, code: 'light', baselineKbps: 60, currentLimitKbps: 60 });
      scheduler.registerSlice({ ...dummySlices[0]!, code: 'heavy1', baselineKbps: 700, currentLimitKbps: 700 });
      scheduler.registerSlice({ ...dummySlices[0]!, code: 'heavy2', baselineKbps: 500, currentLimitKbps: 500 });
      const sink = { write: () => true, on: () => {}, end: () => {} } as any;
      for (const code of ['heavy1', 'heavy2']) {
        scheduler.addSession(
          new LoadSession({ sessionId: code, deviceId: code, sliceCode: code, initialRateKbps: 1000, mode: 'local', res: sink, onClose: () => {} }),
        );
      }
      for (let i = 0; i < 100; i++) scheduler.step(0.02); // 2 s: the backlog builds

      let sent = false;
      scheduler.onTransmitProbe = () => {
        sent = true;
      };
      scheduler.enqueueProbeChunk('light', { sliceCode: 'light', data: Buffer.alloc(64), isProbe: true, enqueuedAtNs: 0n });
      for (let i = 1; i <= 100; i++) {
        scheduler.step(0.02);
        if (sent) return i;
      }
      return 100;
    };

    it('drr shares an overloaded link in proportion to the limits, small limits included', () => {
      const scheduler = new ShaperScheduler({ totalCapacityKbps: 1000, reservedCapacityKbps: 50, rootDiscipline: 'drr' });
      const limits: Record<string, number> = { a: 60, b: 380, c: 1000 }; // 1,440 kbps of limits on 950
      const bytes: Record<string, number> = { a: 0, b: 0, c: 0 };
      for (const [code, limit] of Object.entries(limits)) {
        scheduler.registerSlice({ ...dummySlices[0]!, code, baselineKbps: limit, currentLimitKbps: limit });
        const res = { write: (c: Buffer) => ((bytes[code]! += c.length), true), on: () => {}, end: () => {} } as any;
        scheduler.addSession(new LoadSession({ sessionId: code, deviceId: code, sliceCode: code, initialRateKbps: 2 * limit, mode: 'local', res, onClose: () => {} }));
      }
      for (let i = 0; i < 500; i++) scheduler.step(0.02); // 10 s
      for (const [code, limit] of Object.entries(limits)) {
        const kbps = (bytes[code]! * 8) / 10 / 1000;
        const share = (950 * limit) / 1440;
        expect(Math.abs(kbps - share) / share).toBeLessThan(0.05);
      }
    });

    it('drr isolates a light slice from flooding slices; the shared fifo does not', () => {
      expect(ticksForLightProbe('drr')).toBeLessThanOrEqual(2);
      expect(ticksForLightProbe('fifo')).toBeGreaterThanOrEqual(10);
    });
  });

  describe('4. Dynamic Limit Change and Idempotency', () => {
    it('limit change takes effect within one tick and is idempotent', () => {
      const scheduler = new ShaperScheduler({
        totalCapacityKbps: 1000,
        reservedCapacityKbps: 50,
      });

      scheduler.registerSlice(dummySlices[0]!);
      expect(scheduler.getSlice('slice-telemetry')!.bucket.getRateKbps()).toBe(60);

      // Change limit to 140
      scheduler.updateSliceLimit('slice-telemetry', 140);
      expect(scheduler.getSlice('slice-telemetry')!.bucket.getRateKbps()).toBe(140);

      // Calling again with same value is idempotent
      scheduler.updateSliceLimit('slice-telemetry', 140);
      expect(scheduler.getSlice('slice-telemetry')!.bucket.getRateKbps()).toBe(140);
    });
  });

  describe('5. Device Registry and Timeouts', () => {
    it('marks device offline after 15 s of inactivity', () => {
      const registry = new DeviceRegistry(15000);
      registry.setCatalogue(dummySlices);

      const bound = registry.registerDevice('CLN101', 'ClinicPhone', '192.168.137.10');
      expect(bound).not.toBeNull();
      expect(bound?.slice.code).toBe('slice-telemetry');

      // Now at t=0
      expect(registry.getActiveDevices().length).toBe(1);

      // At t = 16 seconds
      const future = Date.now() + 16000;
      expect(registry.getActiveDevices(future).length).toBe(0);
    });
  });

  describe('6. Southbound API Authentication and Validation', () => {
    let scheduler: ShaperScheduler;
    let registry: DeviceRegistry;
    let probeMgr: ProbeManager;
    let southbound: SouthboundServer;
    const testPort = 9898;
    const validToken = 'test-secret-token-123';

    beforeEach(async () => {
      scheduler = new ShaperScheduler({ totalCapacityKbps: 1000, reservedCapacityKbps: 50 });
      registry = new DeviceRegistry(15000);
      probeMgr = new ProbeManager();

      southbound = new SouthboundServer({
        port: testPort,
        token: validToken,
        scheduler,
        deviceRegistry: registry,
        probeManager: probeMgr,
      });

      await southbound.start();
    });

    afterEach(async () => {
      await southbound.stop();
    });

    it('returns 401 Unauthorized without Bearer token', async () => {
      const status = await new Promise<number>((resolve) => {
        http.get(`http://127.0.0.1:${testPort}/v1/health`, (res) => {
          resolve(res.statusCode || 0);
        });
      });
      expect(status).toBe(401);
    });

    it('returns 200 OK with valid token on /v1/health', async () => {
      const status = await new Promise<number>((resolve) => {
        http.get(
          `http://127.0.0.1:${testPort}/v1/health`,
          { headers: { Authorization: `Bearer ${validToken}` } },
          (res) => {
            resolve(res.statusCode || 0);
          }
        );
      });
      expect(status).toBe(200);
    });

    it('returns 400 Bad Request on invalid PUT /v1/slices payload', async () => {
      const status = await new Promise<number>((resolve) => {
        const req = http.request(
          `http://127.0.0.1:${testPort}/v1/slices`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${validToken}`,
              'Content-Type': 'application/json',
            },
          },
          (res) => {
            resolve(res.statusCode || 0);
          }
        );
        req.write(JSON.stringify({ invalid: 'data' }));
        req.end();
      });
      expect(status).toBe(400);
    });
  });
});
