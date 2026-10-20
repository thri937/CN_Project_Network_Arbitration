import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { env } from '@/config/env';
import { AuditAction } from '@/constants/enums';
import type { INetworkTelemetryPort } from '@/interfaces/telemetry.port';
import type { SliceRepository } from '@/repositories/slice.repository';
import type { TelemetryService } from '@/services/telemetry.service';
import type { AuditService } from '@/services/audit.service';
import type { ContentionService } from '@/services/contention.service';
import { GatewayTelemetryAdapter } from '@/telemetry/adapters/gateway.telemetry.adapter';
import { ExperimentRecorder } from '@/testbed/experimentRecorder';
import { asyncHandler } from '@/utils/asyncHandler';
import { ok } from '@/utils/http';
import { NotFoundError, ValidationError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';

const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|bluetooth|tailscale|zerotier/i;

function interfaceRank(name: string, ip: string): number {
  if (ip.startsWith('192.168.137.') || /hotspot/i.test(name)) return 0;
  if (VIRTUAL_ADAPTER.test(name) || ip.startsWith('192.168.56.')) return 3;
  if (/wi-?fi|wlan|wireless/i.test(name)) return 1;
  return 2;
}

const log = createLogger('testbed-controller');

export interface ExperimentRecord {
  id: string;
  name: string;
  startedAtMs: number;
  stoppedAtMs?: number;
  filePath: string;
  rowCount: number;
}

export interface TestbedControllerDeps {
  autoArbitration: { enabled: boolean };
  telemetryProvider: INetworkTelemetryPort;
  slices: SliceRepository;
  telemetryService: TelemetryService;
  auditService: AuditService;
  contention: ContentionService;
}

export function createTestbedController(deps: TestbedControllerDeps) {
  const experimentsDir = path.resolve(process.cwd(), 'experiments');
  if (!fs.existsSync(experimentsDir)) {
    fs.mkdirSync(experimentsDir, { recursive: true });
  }

  let activeExperiment: {
    record: ExperimentRecord;
    stream: fs.WriteStream;
    recorder: ExperimentRecorder;
  } | null = null;

  /** Context written on every row: the arbitration switch and the open contention, if any. */
  const rowContext = (scenario: string) => () => {
    const open = deps.contention.getOpenEvent();
    return {
      scenario,
      arbitrationOn: deps.autoArbitration.enabled,
      contentionState: open?.status ?? 'NONE',
      decisionId: open?.decisionIds[open.decisionIds.length - 1] ?? '',
    };
  };

  // Poll faster than the gateway's 2 s window; the recorder writes each window exactly once.
  setInterval(() => {
    if (!activeExperiment) return;
    activeExperiment.recorder
      .poll()
      .then((rows) => {
        if (activeExperiment) activeExperiment.record.rowCount += rows;
      })
      .catch(() => undefined);
  }, 500).unref();

  return {
    /** GET /api/v1/testbed/status */
    status: asyncHandler(async (req: Request, res: Response) => {
      let gatewayOk = false;
      let gatewayUptimeS = 0;
      let capacity: any = null;

      try {
        await deps.telemetryProvider.ping();
        gatewayOk = true;
        capacity = await deps.telemetryProvider.describeCapacity();
      } catch (err: any) {
        gatewayOk = false;
      }

      // Auto-start continuous experiment logging whenever gateway is online
      if (gatewayOk && !activeExperiment) {
        try {
          const fileName = `${Date.now()}-Continuous-Testbed-Logging.csv`;
          const filePath = path.join(experimentsDir, fileName);
          const stream = fs.createWriteStream(filePath, { flags: 'a' });
          const recorder = new ExperimentRecorder(
            deps.telemetryProvider as any,
            stream,
            rowContext('Continuous-Logging')
          );
          activeExperiment = {
            record: {
              id: String(Date.now()),
              name: 'Continuous-Logging',
              startedAtMs: Date.now(),
              fileName,
              rowCount: 0,
            },
            stream,
            recorder,
          };
        } catch {}
      }

      // Discover LAN IPs
      const nets = os.networkInterfaces();
      const lanIps: { interface: string; ip: string; isHotspot: boolean; virtual: boolean }[] = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
            const isHotspot = net.address.startsWith('192.168.137.') || name.toLowerCase().includes('hotspot');
            lanIps.push({
              interface: name,
              ip: net.address,
              isHotspot,
              virtual: interfaceRank(name, net.address) === 3,
            });
          }
        }
      }

      // Hotspot first, then Wi-Fi, then Ethernet; virtual adapters last — the dashboard's QR
      // codes use the first entry by default.
      lanIps.sort((a, b) => interfaceRank(a.interface, a.ip) - interfaceRank(b.interface, b.ip));

      ok(req, res, {
        gatewayOk,
        gatewayUptimeS,
        capacity,
        lanIps,
        bandwidthUnit: env.BANDWIDTH_UNIT,
        autoArbitration: deps.autoArbitration.enabled,
        activeExperiment: activeExperiment ? activeExperiment.record : null,
      });
    }),

    /** GET /api/v1/testbed/devices */
    devices: asyncHandler(async (req: Request, res: Response) => {
      const gatewayUrl = env.GATEWAY_URL;
      const token = env.GATEWAY_TOKEN;

      try {
        const response = await fetch(`${gatewayUrl}/v1/devices`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const devices = await response.json();
        ok(req, res, devices);
      } catch (err: any) {
        ok(req, res, []);
      }
    }),

    /** DELETE /api/v1/testbed/devices/:id */
    unbindDevice: asyncHandler(async (req: Request, res: Response) => {
      const id = req.params.id;
      ok(req, res, { unbind: true, deviceId: id });
    }),

    /** POST /api/v1/testbed/slices/:id/join-code/rotate */
    rotateJoinCode: asyncHandler(async (req: Request, res: Response) => {
      const sliceId = req.params.id || '';
      const slice = await deps.slices.base.findById(sliceId);
      if (!slice) {
        throw new NotFoundError('Slice', sliceId);
      }

      const prefix = slice.code.slice(0, 3).toUpperCase();
      const newCode = `${prefix}${Math.floor(100 + Math.random() * 900)}`;

      const updatedTags = slice.tags.filter((t: string) => !t.startsWith('join:'));
      updatedTags.push(`join:${newCode}`);

      await deps.slices.base.update(slice.id, {
        tags: updatedTags,
      });

      // Push to gateway if active
      try {
        const allSlices = await deps.slices.listAll();
        const cat = allSlices.map((s) => {
          const jc = s.tags.find((t: string) => t.startsWith('join:'))?.slice(5) || 'JOIN01';
          return {
            code: s.code,
            name: s.name,
            department: s.departmentId,
            sNssai: s.snssai,
            profile: s.profile,
            baselineKbps: s.baselineAllocatedMbps,
            floorKbps: s.minGuaranteedMbps,
            burstKbps: s.maxBurstMbps,
            currentLimitKbps: s.baselineAllocatedMbps,
            slaTargets: {
              latencyMs: s.slaTargets.maxLatencyMs,
              jitterMs: s.slaTargets.maxJitterMs,
              lossPct: s.slaTargets.maxPacketLossPercent,
              minThroughputKbps: s.slaTargets.minThroughputMbps,
              availabilityPct: s.slaTargets.availabilityPercent,
            },
            joinCode: jc,
          };
        });
        if ((deps.telemetryProvider as any).pushCatalogue) {
          await (deps.telemetryProvider as any).pushCatalogue(cat);
        }
      } catch {}

      ok(req, res, { sliceId: slice.id, code: slice.code, newJoinCode: newCode });
    }),

    /** POST /api/v1/testbed/slices/:id/demand */
    setSliceDemand: asyncHandler(async (req: Request, res: Response) => {
      const sliceId = req.params.id || '';
      const slice = await deps.slices.base.findById(sliceId);
      if (!slice) {
        throw new NotFoundError('Slice', sliceId);
      }

      const { kbps, mode } = req.body as { kbps: number; mode?: 'local' | 'internet' };
      const gatewayUrl = env.GATEWAY_URL;
      const token = env.GATEWAY_TOKEN;

      const response = await fetch(`${gatewayUrl}/v1/slices/${slice.code}/demand`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ kbps, mode }),
      });

      const result = await response.json();
      ok(req, res, result);
    }),

    /** POST /api/v1/testbed/scenarios/:name/run */
    runScenario: asyncHandler(async (req: Request, res: Response) => {
      const name = (req.params.name || '').toUpperCase();
      const allSlices = await deps.slices.listAll();

      const setDemand = async (code: string, kbps: number) => {
        try {
          await fetch(`${env.GATEWAY_URL}/v1/slices/${code}/demand`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.GATEWAY_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ kbps }),
          });
        } catch {}
      };

      if (name === 'TC1') {
        for (const s of allSlices) {
          await setDemand(s.code, Math.round(s.baselineAllocatedMbps * 0.55));
        }
      } else if (name === 'TC2') {
        for (const s of allSlices) {
          const rate = s.code.includes('canteen')
            ? s.baselineAllocatedMbps * 2
            : Math.round(s.baselineAllocatedMbps * 0.55);
          await setDemand(s.code, rate);
        }
      } else if (name === 'TC3') {
        for (const s of allSlices) {
          let multiplier = 0.55;
          if (s.code.includes('canteen')) multiplier = 2.0;
          else if (s.code.includes('office') || s.code.includes('cctv')) multiplier = 1.0;
          else if (s.code.includes('warehouse')) multiplier = 0.8;
          await setDemand(s.code, Math.round(s.baselineAllocatedMbps * multiplier));
        }
      } else if (name === 'TC4') {
        for (const s of allSlices) {
          await setDemand(s.code, s.baselineAllocatedMbps);
        }
      } else if (name === 'TC5') {
        for (const s of allSlices) {
          await setDemand(s.code, Math.round(s.baselineAllocatedMbps * 0.55));
        }
      }

      ok(req, res, { scenario: name, started: true, timestamp: Date.now() });
    }),

    /** PUT /api/v1/testbed/arbitration */
    setArbitration: asyncHandler(async (req: Request, res: Response) => {
      const { enabled } = req.body as { enabled: boolean };
      deps.autoArbitration.enabled = Boolean(enabled);

      await deps.auditService.record({
        action: AuditAction.SETTINGS_UPDATED,
        actor: {
          userId: (req as any).user?.id || 'operator',
          email: (req as any).user?.email || 'operator@example.com',
          role: (req as any).user?.role || 'MANAGER',
          correlationId: (req as any).id || 'testbed-operator',
        },
        summary: `Automatic arbitration toggled ${deps.autoArbitration.enabled ? 'ON' : 'OFF'}`,
        target: { type: 'SETTINGS', id: 'auto-arbitration' },
      });

      ok(req, res, { enabled: deps.autoArbitration.enabled });
    }),

    /** POST /api/v1/testbed/experiments */
    startExperiment: asyncHandler(async (req: Request, res: Response) => {
      const { name } = req.body as { name: string };
      if (!name) {
        throw new ValidationError('Experiment name is required', []);
      }

      if (activeExperiment) {
        activeExperiment.stream.end();
      }

      const id = `exp-${Date.now()}`;
      const fileName = `${Date.now()}-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`;
      const filePath = path.join(experimentsDir, fileName);

      // Experiments record the gateway's own measurements, so they need the gateway provider.
      const provider = deps.telemetryProvider;
      if (!(provider instanceof GatewayTelemetryAdapter)) {
        throw new ValidationError('Experiments need TELEMETRY_PROVIDER=gateway', []);
      }

      const stream = fs.createWriteStream(filePath, { flags: 'a' });
      const recorder = new ExperimentRecorder(
        () => provider.readStats(),
        rowContext(name),
        (line) => stream.write(line),
      );

      activeExperiment = {
        record: {
          id,
          name,
          startedAtMs: Date.now(),
          filePath,
          rowCount: 0,
        },
        stream,
        recorder,
      };

      ok(req, res, activeExperiment.record);
    }),

    /** POST /api/v1/testbed/experiments/:id/stop */
    stopExperiment: asyncHandler(async (req: Request, res: Response) => {
      if (!activeExperiment) {
        throw new NotFoundError('Active experiment', 'current');
      }

      const record = { ...activeExperiment.record, stoppedAtMs: Date.now() };
      activeExperiment.stream.end();
      activeExperiment = null;

      ok(req, res, record);
    }),

    /** GET /api/v1/testbed/experiments/:id/download */
    downloadExperimentCsv: asyncHandler(async (req: Request, res: Response) => {
      const expId = req.params.id || '';
      const files = fs.readdirSync(experimentsDir);
      const match = files.find((f) => f.includes(expId) || f === expId);

      if (!match) {
        throw new NotFoundError('Experiment file', expId);
      }

      const fullPath = path.join(experimentsDir, match);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${match}"`);
      fs.createReadStream(fullPath).pipe(res);
    }),
  };
}
