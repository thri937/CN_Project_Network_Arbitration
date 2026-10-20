import http, { IncomingMessage, ServerResponse } from 'node:http';
import {
  CapacityResponseSchema,
  HealthResponseSchema,
  SliceCatalogueItem,
  SliceCatalogueSchema,
  SliceDemandControlSchema,
  SliceLimitUpdateSchema,
} from '@cn/shared';
import { ShaperScheduler } from '../shaper/scheduler.js';
import { DeviceRegistry } from '../sessions/deviceRegistry.js';
import { ProbeManager } from '../probes/probeManager.js';

export interface SouthboundServerOptions {
  port: number;
  token: string;
  scheduler: ShaperScheduler;
  deviceRegistry: DeviceRegistry;
  probeManager: ProbeManager;
  onOperatorDemand?: (sliceCode: string, demandKbps: number, mode?: 'local' | 'internet') => void;
  onLatestDecision?: (sliceCode: string, decisionId: string, reason: string) => void;
}

export class SouthboundServer {
  private port: number;
  private token: string;
  private scheduler: ShaperScheduler;
  private deviceRegistry: DeviceRegistry;
  private probeManager: ProbeManager;
  private onOperatorDemand?: (sliceCode: string, demandKbps: number, mode?: 'local' | 'internet') => void;
  private onLatestDecision?: (sliceCode: string, decisionId: string, reason: string) => void;
  private server?: http.Server;
  private startTime = Date.now();

  constructor(opts: SouthboundServerOptions) {
    this.port = opts.port;
    this.token = opts.token;
    this.scheduler = opts.scheduler;
    this.deviceRegistry = opts.deviceRegistry;
    this.probeManager = opts.probeManager;
    this.onOperatorDemand = opts.onOperatorDemand;
    this.onLatestDecision = opts.onLatestDecision;
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // BIND TO 127.0.0.1 ONLY as required by §6.2
      this.server.listen(this.port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, body: any): void {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Check Authorization header: Bearer $GATEWAY_TOKEN
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      this.sendJson(res, 401, { error: 'Unauthorized: missing Bearer token' });
      return;
    }

    const token = authHeader.slice(7).trim();
    if (token !== this.token) {
      this.sendJson(res, 401, { error: 'Unauthorized: invalid token' });
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const method = req.method?.toUpperCase();
    const pathname = url.pathname;

    // GET /v1/health
    if (method === 'GET' && pathname === '/v1/health') {
      const uptimeS = Math.floor((Date.now() - this.startTime) / 1000);
      const data = { ok: true, uptimeS, version: '1.0.0' };
      const parsed = HealthResponseSchema.parse(data);
      this.sendJson(res, 200, parsed);
      return;
    }

    // GET /v1/capacity
    if (method === 'GET' && pathname === '/v1/capacity') {
      const data = {
        totalKbps: this.scheduler.getTotalKbps(),
        reservedKbps: this.scheduler.getReservedKbps(),
        offeredKbps: this.scheduler.getOfferedKbps(),
        unit: 'kbps' as const,
        source: 'configuration',
      };
      const parsed = CapacityResponseSchema.parse(data);
      this.sendJson(res, 200, parsed);
      return;
    }

    // PUT /v1/slices (Catalogue sync)
    if (method === 'PUT' && pathname === '/v1/slices') {
      this.parseBody(req)
        .then((body) => {
          let slicesList: SliceCatalogueItem[];
          if (Array.isArray(body)) {
            slicesList = body;
          } else if (body && Array.isArray(body.slices)) {
            slicesList = body.slices;
          } else {
            this.sendJson(res, 400, { error: 'Invalid slice catalogue body' });
            return;
          }

          const parsed = SliceCatalogueSchema.safeParse(body);
          if (!parsed.success) {
            this.sendJson(res, 400, { error: 'Validation failed', details: parsed.error.issues });
            return;
          }

          for (const s of slicesList) {
            this.scheduler.registerSlice(s);
          }
          this.deviceRegistry.setCatalogue(slicesList);

          this.sendJson(res, 200, { accepted: true, count: slicesList.length });
        })
        .catch((err) => {
          this.sendJson(res, 400, { error: 'Malformed JSON', message: err.message });
        });
      return;
    }

    // GET /v1/stats
    if (method === 'GET' && pathname === '/v1/stats') {
      const allSlices = this.scheduler.getAllSlices();
      const stats = allSlices.map((s) => {
        const activeDevices = this.deviceRegistry.getActiveDevicesForSlice(s.item.code);
        const activeCount = activeDevices.length;
        const sessionCount = s.sessions.size;

        s.meter.updateActiveCounts(activeCount, sessionCount);

        const probeStats = this.probeManager.computeWindowStats(s.item.code, activeCount > 0);
        return s.meter.rotateWindow(2.0, probeStats, s.queue.getDepthBytes());
      });

      this.sendJson(res, 200, stats);
      return;
    }

    // PUT /v1/slices/:code/limit
    const limitMatch = pathname.match(/^\/v1\/slices\/([^/]+)\/limit$/);
    if (method === 'PUT' && limitMatch) {
      const sliceCode = limitMatch[1]!;
      this.parseBody(req)
        .then((body) => {
          const parsed = SliceLimitUpdateSchema.safeParse(body);
          if (!parsed.success) {
            this.sendJson(res, 400, { error: 'Validation failed', details: parsed.error.issues });
            return;
          }

          const { limitKbps, decisionId, reason } = parsed.data;
          const ok = this.scheduler.updateSliceLimit(sliceCode, limitKbps);
          if (!ok) {
            this.sendJson(res, 404, { error: `Slice ${sliceCode} not found` });
            return;
          }

          if (decisionId && reason && this.onLatestDecision) {
            this.onLatestDecision(sliceCode, decisionId, reason);
          }

          this.sendJson(res, 200, { applied: true, effectiveKbps: limitKbps });
        })
        .catch((err) => {
          this.sendJson(res, 400, { error: 'Malformed JSON', message: err.message });
        });
      return;
    }

    // GET /v1/devices
    if (method === 'GET' && pathname === '/v1/devices') {
      const devices = this.deviceRegistry.getActiveDevices();
      this.sendJson(res, 200, devices);
      return;
    }

    // POST /v1/slices/:code/demand
    const demandMatch = pathname.match(/^\/v1\/slices\/([^/]+)\/demand$/);
    if (method === 'POST' && demandMatch) {
      const sliceCode = demandMatch[1]!;
      this.parseBody(req)
        .then((body) => {
          const parsed = SliceDemandControlSchema.safeParse(body);
          if (!parsed.success) {
            this.sendJson(res, 400, { error: 'Validation failed', details: parsed.error.issues });
            return;
          }

          if (this.onOperatorDemand) {
            this.onOperatorDemand(sliceCode, parsed.data.kbps, parsed.data.mode);
          }

          this.sendJson(res, 200, { success: true, sliceCode, demand: parsed.data });
        })
        .catch((err) => {
          this.sendJson(res, 400, { error: 'Malformed JSON', message: err.message });
        });
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }
}
