import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { WebSocketServer, WebSocket } from 'ws';
import {
  HealthStatus,
  JoinRequestSchema,
  ProbeBatchReportSchema,
  SessionPatchRequestSchema,
  SliceSnapshot,
  SliceState,
} from '@cn/shared';
import { ShaperScheduler } from '../shaper/scheduler.js';
import { DeviceRegistry } from '../sessions/deviceRegistry.js';
import { ProbeManager } from '../probes/probeManager.js';
import { LoadSession } from '../sessions/loadSession.js';

export interface PortalServerOptions {
  port: number;
  scheduler: ShaperScheduler;
  deviceRegistry: DeviceRegistry;
  probeManager: ProbeManager;
  staticDir?: string;
  internetSourceUrl?: string;
}

export class PortalServer {
  private port: number;
  private scheduler: ShaperScheduler;
  private deviceRegistry: DeviceRegistry;
  private probeManager: ProbeManager;
  private staticDir: string;
  private internetSourceUrl: string;

  private server?: http.Server;
  private wss?: WebSocketServer;
  private activeSessions = new Map<string, LoadSession>();
  // deviceId -> Set of WebSockets
  private deviceSockets = new Map<string, Set<WebSocket>>();
  // sliceCode -> { decisionId, reason, atMs }
  private latestDecisions = new Map<string, { decisionId: string; reason: string; atMs: number }>();

  // WebSocket push timer
  private pushTimer?: NodeJS.Timeout;

  constructor(opts: PortalServerOptions) {
    this.port = opts.port;
    this.scheduler = opts.scheduler;
    this.deviceRegistry = opts.deviceRegistry;
    this.probeManager = opts.probeManager;
    this.staticDir =
      opts.staticDir || path.resolve(__dirname, '../../../../portal/dist');
    this.internetSourceUrl =
      opts.internetSourceUrl || 'https://speed.cloudflare.com/__down?bytes=25000000';

    // Hook probe completion into scheduler transmit
    this.scheduler.onTransmitProbe = (chunk) => {
      if (chunk.isProbe && (chunk as any)._probeHandle) {
        this.probeManager.completeProbe((chunk as any)._probeHandle);
      }
    };
  }

  public recordDecision(sliceCode: string, decisionId: string, reason: string): void {
    this.latestDecisions.set(sliceCode, { decisionId, reason, atMs: Date.now() });
  }

  public handleOperatorDemand(
    sliceCode: string,
    demandKbps: number,
    mode?: 'local' | 'internet'
  ): void {
    const devices = this.deviceRegistry.getActiveDevicesForSlice(sliceCode);
    for (const dev of devices) {
      if (dev.operatorControlEnabled) {
        // Push remote demand update over WS
        const sockets = this.deviceSockets.get(dev.deviceId);
        if (sockets) {
          const msg = JSON.stringify({
            type: 'operator-demand',
            rateKbps: demandKbps,
            mode: mode || 'local',
          });
          for (const ws of sockets) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(msg);
            }
          }
        }

        // Also adjust any active load sessions for this device
        for (const session of this.activeSessions.values()) {
          if (session.deviceId === dev.deviceId) {
            session.updateRate(demandKbps, mode);
          }
        }
      }
    }
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      this.wss = new WebSocketServer({ noServer: true });
      this.server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        if (url.pathname === '/ws') {
          this.wss?.handleUpgrade(req, socket, head, (ws) => {
            this.handleWebSocketConnection(ws, url);
          });
        } else {
          socket.destroy();
        }
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        this.startSnapshotPusher();
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = undefined;
    }
    // Close active sessions
    for (const s of this.activeSessions.values()) {
      s.destroy();
    }
    this.activeSessions.clear();

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close();
      }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private startSnapshotPusher(): void {
    this.pushTimer = setInterval(() => {
      for (const [deviceId, sockets] of this.deviceSockets.entries()) {
        if (sockets.size === 0) continue;
        const snapshot = this.getSnapshotForDevice(deviceId);
        if (!snapshot) continue;

        const payload = JSON.stringify({ type: 'snapshot', snapshot });
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
          }
        }
      }
    }, 1000);
  }

  private handleWebSocketConnection(ws: WebSocket, url: URL): void {
    const deviceId = url.searchParams.get('device') || '';
    if (deviceId) {
      this.deviceRegistry.touchDevice(deviceId);
      if (!this.deviceSockets.has(deviceId)) {
        this.deviceSockets.set(deviceId, new Set());
      }
      this.deviceSockets.get(deviceId)!.add(ws);

      // Send initial snapshot immediately
      const initialSnapshot = this.getSnapshotForDevice(deviceId);
      if (initialSnapshot) {
        ws.send(JSON.stringify({ type: 'snapshot', snapshot: initialSnapshot }));
      }
    }

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', atMs: Date.now() }));
        }
        if (deviceId) {
          this.deviceRegistry.touchDevice(deviceId);
        }
      } catch {}
    });

    ws.on('close', () => {
      if (deviceId && this.deviceSockets.has(deviceId)) {
        this.deviceSockets.get(deviceId)!.delete(ws);
      }
    });
  }

  public getSnapshotForDevice(deviceId: string): SliceSnapshot | null {
    const dev = this.deviceRegistry.getDevice(deviceId);
    if (!dev) return null;

    const sliceItem = this.deviceRegistry.getSliceByCode(dev.sliceCode);
    if (!sliceItem) return null;

    const sliceRuntime = this.scheduler.getSlice(dev.sliceCode);
    const stats = sliceRuntime
      ? sliceRuntime.meter.getLatestStats()
      : {
          code: dev.sliceCode,
          atMs: Date.now(),
          demandKbps: 0,
          limitKbps: sliceItem.currentLimitKbps,
          usedKbps: 0,
          droppedKbps: 0,
          queueMs: 0,
          latencyP50Ms: null,
          latencyP95Ms: null,
          jitterMs: null,
          lossPct: 0,
          availabilityPct: null,
          activeDevices: 0,
          activeSessions: 0,
          saturated: false,
        };

    // Calculate state & degradation
    let state: SliceState = 'NORMAL';
    let degradationPct = 0;
    if (stats.limitKbps < sliceItem.baselineKbps) {
      state = 'DEGRADED';
      degradationPct = Math.round(
        ((sliceItem.baselineKbps - stats.limitKbps) / sliceItem.baselineKbps) * 100
      );
    } else if (stats.limitKbps > sliceItem.baselineKbps) {
      state = 'PROTECTED';
    }

    // Determine health
    let health: HealthStatus = 'HEALTHY';
    if (stats.latencyP95Ms === null) {
      health = 'UNKNOWN';
    } else if (
      stats.latencyP95Ms > sliceItem.slaTargets.latencyMs ||
      stats.lossPct > sliceItem.slaTargets.lossPct
    ) {
      health = stats.lossPct > sliceItem.slaTargets.lossPct * 2 ? 'CRITICAL' : 'VIOLATING';
    } else if (state === 'DEGRADED') {
      health = 'DEGRADED';
    }

    const connectedDevices = this.deviceRegistry.getActiveDevicesForSlice(dev.sliceCode).length;
    const latestDecision = this.latestDecisions.get(dev.sliceCode);

    return {
      slice: sliceItem,
      stats,
      health,
      state,
      degradationPct,
      latestDecision,
      connectedDevices,
    };
  }

  private sendJson(res: ServerResponse, statusCode: number, body: any): void {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.end(JSON.stringify(body));
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // Enable CORS
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase();

    // POST /portal-api/join
    if (method === 'POST' && pathname === '/portal-api/join') {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          const body = JSON.parse(data);
          const parsed = JoinRequestSchema.safeParse(body);
          if (!parsed.success) {
            this.sendJson(res, 400, { error: 'Validation failed', details: parsed.error.issues });
            return;
          }

          const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
          const cleanIp = clientIp.replace(/^::ffff:/, '');

          const bound = this.deviceRegistry.registerDevice(
            parsed.data.code,
            parsed.data.nickname,
            cleanIp,
            req.headers['user-agent']
          );

          if (!bound) {
            this.sendJson(res, 404, { error: 'Invalid join code or slice not found' });
            return;
          }

          this.sendJson(res, 200, bound);
        } catch (e: any) {
          this.sendJson(res, 400, { error: 'Invalid JSON', message: e.message });
        }
      });
      return;
    }

    // GET /portal-api/slices
    if (method === 'GET' && pathname === '/portal-api/slices') {
      const slices = this.deviceRegistry.getAllSlices();
      this.sendJson(res, 200, slices);
      return;
    }

    // PATCH /portal-api/sessions/:id
    const patchSessionMatch = pathname.match(/^\/portal-api\/sessions\/([^/]+)$/);
    if (method === 'PATCH' && patchSessionMatch) {
      const sessionId = patchSessionMatch[1]!;
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          const body = JSON.parse(data);
          const parsed = SessionPatchRequestSchema.safeParse(body);
          if (!parsed.success) {
            this.sendJson(res, 400, { error: 'Validation failed', details: parsed.error.issues });
            return;
          }

          const session = this.activeSessions.get(sessionId);
          if (!session) {
            this.sendJson(res, 404, { error: 'Session not found' });
            return;
          }

          session.updateRate(parsed.data.rateKbps, parsed.data.mode);
          this.deviceRegistry.updateDeviceRate(
            session.deviceId,
            parsed.data.rateKbps,
            parsed.data.mode
          );
          if (parsed.data.operatorControlEnabled !== undefined) {
            this.deviceRegistry.setOperatorControl(
              session.deviceId,
              parsed.data.operatorControlEnabled
            );
          }

          this.sendJson(res, 200, {
            sessionId,
            rateKbps: session.getRateKbps(),
            mode: session.getMode(),
          });
        } catch (e: any) {
          this.sendJson(res, 400, { error: 'Invalid JSON', message: e.message });
        }
      });
      return;
    }

    // POST /portal-api/probe-results
    if (method === 'POST' && pathname === '/portal-api/probe-results') {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          const body = JSON.parse(data);
          const parsed = ProbeBatchReportSchema.safeParse(body);
          if (!parsed.success) {
            this.sendJson(res, 400, { error: 'Validation failed', details: parsed.error.issues });
            return;
          }

          const dev = this.deviceRegistry.touchDevice(parsed.data.deviceId);
          if (dev) {
            this.probeManager.ingestResults(dev.sliceCode, parsed.data.results);
          }

          this.sendJson(res, 200, { accepted: true, count: parsed.data.results.length });
        } catch (e: any) {
          this.sendJson(res, 400, { error: 'Invalid JSON', message: e.message });
        }
      });
      return;
    }

    // GET /portal-api/snapshot
    if (method === 'GET' && pathname === '/portal-api/snapshot') {
      const deviceId = url.searchParams.get('device');
      if (!deviceId) {
        this.sendJson(res, 400, { error: 'Missing device query parameter' });
        return;
      }
      const snapshot = this.getSnapshotForDevice(deviceId);
      if (!snapshot) {
        this.sendJson(res, 404, { error: 'Device not found' });
        return;
      }
      this.sendJson(res, 200, snapshot);
      return;
    }

    // GET /load/down?device=<id>&rate=<kbps>&mode=local|internet
    if (method === 'GET' && pathname === '/load/down') {
      const deviceId = url.searchParams.get('device') || '';
      const dev = this.deviceRegistry.touchDevice(deviceId);
      if (!dev) {
        this.sendJson(res, 403, { error: 'Device not bound. Join slice first at /join' });
        return;
      }

      const rateKbps = Math.max(0, parseInt(url.searchParams.get('rate') || '50', 10));
      const mode = (url.searchParams.get('mode') === 'internet' ? 'internet' : 'local') as
        | 'local'
        | 'internet';

      const sessionId = `sess-${crypto.randomBytes(6).toString('hex')}`;

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Session-ID', sessionId);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Transfer-Encoding', 'chunked');

      const session = new LoadSession({
        sessionId,
        deviceId,
        sliceCode: dev.sliceCode,
        initialRateKbps: rateKbps,
        mode,
        res,
        internetSourceUrl: this.internetSourceUrl,
        onClose: (sId) => {
          this.activeSessions.delete(sId);
          this.scheduler.removeSession(dev.sliceCode, sId);
        },
      });

      this.activeSessions.set(sessionId, session);
      this.scheduler.addSession(session);
      this.deviceRegistry.updateDeviceRate(deviceId, rateKbps, mode);

      return;
    }

    // GET /probe?device=<id>&seq=<n>
    if (method === 'GET' && pathname === '/probe') {
      const deviceId = url.searchParams.get('device') || '';
      const seq = parseInt(url.searchParams.get('seq') || '0', 10);
      const dev = this.deviceRegistry.touchDevice(deviceId);

      if (!dev) {
        this.sendJson(res, 403, { error: 'Device not found' });
        return;
      }

      const handle = this.probeManager.createProbeHandle(deviceId, dev.sliceCode, seq, res);

      // Create a 64-byte probe chunk placed into that slice's queue
      const dummyProbeData = Buffer.alloc(64, 0x77);
      const probeChunk = {
        sliceCode: dev.sliceCode,
        data: dummyProbeData,
        isProbe: true,
        probeSeq: seq,
        enqueuedAtNs: handle.arrivedAtNs,
        _probeHandle: handle,
      };

      const enqueued = this.scheduler.enqueueProbeChunk(dev.sliceCode, probeChunk);
      if (!enqueued) {
        // Dropped immediately due to full slice queue
        this.probeManager.recordLostProbe(dev.sliceCode);
        this.sendJson(res, 503, { error: 'Probe dropped: slice queue full' });
      }

      // Timeout safety: if probe waits in queue > 2000 ms, count as lost
      const timeoutTimer = setTimeout(() => {
        if (!res.writableEnded) {
          this.probeManager.recordLostProbe(dev.sliceCode);
          this.sendJson(res, 504, { error: 'Probe timed out in queue' });
        }
      }, 2000);

      res.on('close', () => clearTimeout(timeoutTimer));
      return;
    }

    // Serve Static Portal Files
    this.serveStatic(req, res, pathname);
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    const slices = this.deviceRegistry.getAllSlices();
    if (slices.length === 0) {
      // Waiting for controller fallback screen
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!DOCTYPE html>
<html>
<head><title>Slice Portal</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;">
  <h2>Slice Gateway Online</h2>
  <p style="color:#94a3b8">Waiting for controller to synchronize slice catalogue...</p>
  <script>setTimeout(() => location.reload(), 2000);</script>
</body>
</html>`);
      return;
    }

    let filePath = path.join(this.staticDir, pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(this.staticDir, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
      // Fallback if portal has not been built yet
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!DOCTYPE html>
<html>
<head><title>Slice Portal</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:2rem;">
  <h2>Slice Gateway Portal</h2>
  <p>Gateway is ready. Active Slices: ${slices.length}</p>
  <ul>
    ${slices.map((s) => `<li><b>${s.name}</b> (${s.department}) — Join Code: <code>${s.joinCode}</code> — Limit: ${s.currentLimitKbps} kbps</li>`).join('')}
  </ul>
</body>
</html>`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.webmanifest': 'application/manifest+json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon',
    };

    res.statusCode = 200;
    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  }
}
