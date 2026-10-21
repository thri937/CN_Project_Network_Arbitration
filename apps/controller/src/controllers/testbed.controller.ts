import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { env } from '@/config/env';
import { AuditAction } from '@/constants/enums';
import type { INetworkTelemetryPort } from '@/interfaces/telemetry.port';
import type { DepartmentRepository } from '@/repositories/department.repository';
import type { SliceRepository } from '@/repositories/slice.repository';
import type { TelemetryService } from '@/services/telemetry.service';
import type { AuditService } from '@/services/audit.service';
import type { ContentionService } from '@/services/contention.service';
import { GatewayTelemetryAdapter } from '@/telemetry/adapters/gateway.telemetry.adapter';
import { catalogueFromSlices } from '@/testbed/catalogue';
import { ExperimentRecorder } from '@/testbed/experimentRecorder';
import type { ActorContext } from '@/types/common';
import { asyncHandler } from '@/utils/asyncHandler';
import { ok } from '@/utils/http';
import { NotFoundError, ValidationError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';

const log = createLogger('testbed-controller');

const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|bluetooth|tailscale|zerotier/i;

/** Hotspot first, then Wi-Fi, then Ethernet; virtual adapters (unreachable from phones) last. */
function interfaceRank(name: string, ip: string): number {
  if (ip.startsWith('192.168.137.') || /hotspot/i.test(name)) return 0;
  if (VIRTUAL_ADAPTER.test(name) || ip.startsWith('192.168.56.')) return 3;
  if (/wi-?fi|wlan|wireless/i.test(name)) return 1;
  return 2;
}

/** Results go to the repository's experiments/ folder, whichever directory the controller runs from. */
const EXPERIMENTS_DIR = path.resolve(__dirname, '../../../../experiments');

/**
 * Demand patterns behind the dashboard's scenario buttons, as a fraction of each slice's baseline.
 * The slice's devices switch to that demand (operator remote control).
 */
const SCENARIOS: Record<string, { label: string; fraction: (code: string) => number }> = {
  IDLE: { label: 'All idle', fraction: () => 0 },
  TC1: { label: 'Normal day', fraction: () => 0.55 },
  TC2: { label: 'Canteen flood', fraction: (c) => (c === 'canteen-signage' ? 2 : 0.55) },
  TC3: {
    label: 'Lunch-hour rush',
    fraction: (c) =>
      ({ 'canteen-signage': 2, 'office-wi-fi': 1, cctv: 1, 'warehouse-operations': 0.8 })[c] ?? 0.55,
  },
  TC4: { label: 'Everyone at peak', fraction: () => 1 },
  TC5: { label: 'Back to normal', fraction: () => 0.55 },
};

export interface RecordingInfo {
  file: string;
  startedAtMs: number;
  rowCount: number;
  label: string;
}

export interface TestbedControllerDeps {
  autoArbitration: { enabled: boolean };
  telemetryProvider: INetworkTelemetryPort;
  slices: SliceRepository;
  departments: DepartmentRepository;
  telemetryService: TelemetryService;
  auditService: AuditService;
  contention: ContentionService;
}

function actorOf(req: Request): ActorContext {
  const user = (req as any).user;
  return {
    userId: user?.id ?? 'operator',
    email: user?.email ?? 'operator@local',
    role: user?.role ?? 'MANAGER',
    correlationId: (req as any).id ?? 'testbed',
  } as ActorContext;
}

export function createTestbedController(deps: TestbedControllerDeps) {
  const gateway =
    deps.telemetryProvider instanceof GatewayTelemetryAdapter ? deps.telemetryProvider : null;

  const requireGateway = (): GatewayTelemetryAdapter => {
    if (!gateway) throw new ValidationError('The testbed needs TELEMETRY_PROVIDER=gateway', []);
    return gateway;
  };

  /* ---- Always-on recording ------------------------------------------- */
  // Every gateway window is written to one CSV per controller run. The label column says which
  // scenario was running, so a session can be cut into test cases afterwards.

  let label = 'live';
  let recording: RecordingInfo | null = null;
  let recorder: ExperimentRecorder | null = null;

  // Off in tests and demo:local (it writes its own CSV): TESTBED_RECORDING=false.
  const recordingEnabled = process.env.NODE_ENV !== 'test' && process.env.TESTBED_RECORDING !== 'false';
  if (gateway && recordingEnabled) {
    fs.mkdirSync(EXPERIMENTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = `${stamp}-session.csv`;
    // Opened on the first line, so starting the controller without traffic leaves no empty file.
    let stream: fs.WriteStream | null = null;
    recording = { file, startedAtMs: Date.now(), rowCount: 0, label };
    recorder = new ExperimentRecorder(
      () => gateway.readStats(),
      () => {
        const open = deps.contention.getOpenEvent();
        return {
          scenario: label,
          arbitrationOn: deps.autoArbitration.enabled,
          contentionState: open?.status ?? 'NONE',
          decisionId: open?.decisionIds[open.decisionIds.length - 1] ?? '',
        };
      },
      (line) => {
        stream ??= fs.createWriteStream(path.join(EXPERIMENTS_DIR, file), { flags: 'a' });
        stream.write(line);
      },
    );
    // Poll faster than the gateway's 2 s window; each window is written exactly once.
    setInterval(() => {
      recorder
        ?.poll()
        .then((rows) => {
          if (recording) recording.rowCount += rows;
        })
        .catch(() => undefined);
    }, 500).unref();
    log.info({ file }, 'recording every gateway window');
  }

  const pushCatalogue = async (): Promise<void> => {
    if (!gateway) return;
    const [slices, departments] = await Promise.all([deps.slices.listAll(), deps.departments.listAll()]);
    const nameOf = (id: string) => departments.find((d) => d.id === id)?.name ?? id;
    await gateway.pushCatalogue(catalogueFromSlices(slices, nameOf));
  };

  return {
    /** GET /api/v1/testbed/status */
    status: asyncHandler(async (req: Request, res: Response) => {
      let gatewayOk = false;
      let capacity: unknown = null;
      try {
        await deps.telemetryProvider.ping();
        capacity = await deps.telemetryProvider.describeCapacity();
        gatewayOk = true;
      } catch {
        gatewayOk = false;
      }

      const lanIps: { interface: string; ip: string; isHotspot: boolean; virtual: boolean }[] = [];
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
          if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
            lanIps.push({
              interface: name,
              ip: net.address,
              isHotspot: interfaceRank(name, net.address) === 0,
              virtual: interfaceRank(name, net.address) === 3,
            });
          }
        }
      }
      lanIps.sort((a, b) => interfaceRank(a.interface, a.ip) - interfaceRank(b.interface, b.ip));

      const stats = gatewayOk && gateway ? await gateway.readStats().catch(() => []) : [];

      ok(req, res, {
        gatewayOk,
        capacity,
        stats,
        lanIps,
        portalPort: Number(process.env.GATEWAY_LAN_PORT ?? 8080),
        bandwidthUnit: env.BANDWIDTH_UNIT,
        autoArbitration: deps.autoArbitration.enabled,
        recording: recording ? { ...recording, label } : null,
      });
    }),

    /** GET /api/v1/testbed/devices */
    devices: asyncHandler(async (req: Request, res: Response) => {
      try {
        ok(req, res, await requireGateway().listDevices());
      } catch {
        ok(req, res, []);
      }
    }),

    /** DELETE /api/v1/testbed/devices/:id */
    unbindDevice: asyncHandler(async (req: Request, res: Response) => {
      const id = req.params.id ?? '';
      const removed = await requireGateway().unbindDevice(id);
      if (!removed) throw new NotFoundError('Device', id);
      await deps.auditService.record({
        action: AuditAction.SETTINGS_UPDATED,
        actor: actorOf(req),
        summary: `Testbed device ${id} removed from its slice`,
        target: { type: 'SETTINGS', id: `device:${id}` },
      });
      ok(req, res, { removed: true, deviceId: id });
    }),

    /** POST /api/v1/testbed/slices/:id/join-code/rotate */
    rotateJoinCode: asyncHandler(async (req: Request, res: Response) => {
      const sliceId = req.params.id ?? '';
      const slice = await deps.slices.base.findById(sliceId);
      if (!slice) throw new NotFoundError('Slice', sliceId);

      const prefix = slice.code.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase();
      const newCode = `${prefix}${Math.floor(100 + Math.random() * 900)}`;
      await deps.slices.base.update(slice.id, {
        tags: [...slice.tags.filter((t: string) => !t.startsWith('join:')), `join:${newCode}`],
      });
      await pushCatalogue().catch(() => undefined);

      ok(req, res, { sliceId: slice.id, code: slice.code, newJoinCode: newCode });
    }),

    /** POST /api/v1/testbed/slices/:id/demand */
    setSliceDemand: asyncHandler(async (req: Request, res: Response) => {
      const sliceId = req.params.id ?? '';
      const slice = await deps.slices.base.findById(sliceId);
      if (!slice) throw new NotFoundError('Slice', sliceId);

      const { kbps, mode } = req.body as { kbps: number; mode?: 'local' | 'internet' };
      if (typeof kbps !== 'number' || kbps < 0 || kbps > 10_000) {
        throw new ValidationError('kbps must be a number from 0 to 10000', []);
      }
      await requireGateway().setDemand(slice.code, Math.round(kbps), mode);
      ok(req, res, { applied: true, sliceCode: slice.code, kbps: Math.round(kbps) });
    }),

    /** POST /api/v1/testbed/scenarios/:name/run */
    runScenario: asyncHandler(async (req: Request, res: Response) => {
      const name = (req.params.name ?? '').toUpperCase();
      const scenario = SCENARIOS[name];
      if (!scenario) throw new NotFoundError('Scenario', name);

      const gw = requireGateway();
      const slices = await deps.slices.listAll();
      for (const s of slices) {
        await gw.setDemand(s.code, Math.round(s.baselineAllocatedMbps * scenario.fraction(s.code))).catch(() => undefined);
      }
      label = name;

      ok(req, res, { scenario: name, label: scenario.label, started: true, timestamp: Date.now() });
    }),

    /** PUT /api/v1/testbed/arbitration */
    setArbitration: asyncHandler(async (req: Request, res: Response) => {
      const { enabled } = req.body as { enabled: boolean };
      deps.autoArbitration.enabled = Boolean(enabled);

      await deps.auditService.record({
        action: AuditAction.SETTINGS_UPDATED,
        actor: actorOf(req),
        summary: `Automatic arbitration turned ${deps.autoArbitration.enabled ? 'ON' : 'OFF'}`,
        target: { type: 'SETTINGS', id: 'auto-arbitration' },
      });

      ok(req, res, { enabled: deps.autoArbitration.enabled });
    }),

    /** GET /api/v1/testbed/recording.csv — the current session's CSV. */
    downloadRecording: asyncHandler(async (req: Request, res: Response) => {
      if (!recording) throw new NotFoundError('Recording', 'session');
      const fullPath = path.join(EXPERIMENTS_DIR, recording.file);
      if (!fs.existsSync(fullPath)) throw new NotFoundError('Recording', recording.file);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${recording.file}"`);
      fs.createReadStream(fullPath).pipe(res);
    }),
  };
}
