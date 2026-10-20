import http from 'node:http';
import os from 'node:os';
import type { BoundDevice, SliceSnapshot } from '@cn/shared';

export interface AgentOptions {
  gatewayUrl?: string;
  code: string;
  name?: string;
  rate?: number;
  mode?: 'local' | 'internet';
  durationSeconds?: number;
  probeIntervalMs?: number;
  headless?: boolean;
  onSnapshot?: (snapshot: SliceSnapshot) => void;
  onLog?: (line: string) => void;
}

export class SliceAgent {
  private gatewayUrl: string;
  private code: string;
  private nickname: string;
  private rateKbps: number;
  private mode: 'local' | 'internet';
  private durationSeconds: number;
  private probeIntervalMs: number;
  private headless: boolean;

  private boundDevice?: BoundDevice;
  private latestSnapshot?: SliceSnapshot;
  private probeTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private durationTimer?: NodeJS.Timeout;
  private displayTimer?: NodeJS.Timeout;
  private ws?: WebSocket;
  private activeLoadReq?: http.ClientRequest;
  private probeSeq = 1;
  private probeBuffer: Array<{ seq: number; sentAtMs: number; recvAtMs: number; rttMs: number }> = [];
  private totalBytesReceived = 0;
  private running = false;

  private onSnapshotCb?: (snapshot: SliceSnapshot) => void;
  private onLogCb?: (line: string) => void;

  constructor(opts: AgentOptions) {
    this.gatewayUrl = (opts.gatewayUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    this.code = opts.code.trim().toUpperCase();
    this.nickname = opts.name || `${os.hostname()}-Agent`;
    this.rateKbps = opts.rate ?? 50;
    this.mode = opts.mode || 'local';
    this.durationSeconds = opts.durationSeconds ?? 0;
    this.probeIntervalMs = opts.probeIntervalMs ?? 1000;
    this.headless = opts.headless ?? true;
    this.onSnapshotCb = opts.onSnapshot;
    this.onLogCb = opts.onLog;
  }

  private log(msg: string) {
    const ts = new Date().toISOString().slice(11, 19);
    const line = `[${ts}] [${this.code}] ${msg}`;
    if (this.onLogCb) {
      this.onLogCb(line);
    } else {
      console.log(line);
    }
  }

  public async start(): Promise<BoundDevice> {
    this.running = true;
    this.log(`Joining gateway at ${this.gatewayUrl} with code "${this.code}" as "${this.nickname}"...`);

    // 1. Join slice
    const joinRes = await fetch(`${this.gatewayUrl}/portal-api/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: this.code,
        nickname: this.nickname,
      }),
    });

    if (!joinRes.ok) {
      const err = await joinRes.text();
      throw new Error(`Failed to join slice (${joinRes.status}): ${err}`);
    }

    this.boundDevice = (await joinRes.json()) as BoundDevice;
    this.log(`Successfully bound deviceId: ${this.boundDevice.deviceId} (Slice: ${this.boundDevice.sliceCode})`);

    // 2. Start WebSocket for live state and remote operator controls
    this.connectWebSocket();

    // 3. Start periodic active RTT probing
    this.startProbing();

    // 4. Start load streaming
    this.startLoadStreaming(this.rateKbps);

    // 5. Periodic status reporter
    this.displayTimer = setInterval(() => {
      this.reportStatus();
    }, 2000);

    // 6. Optional duration limit
    if (this.durationSeconds > 0) {
      this.durationTimer = setTimeout(() => {
        this.log(`Target duration (${this.durationSeconds}s) reached. Stopping agent.`);
        this.stop();
      }, this.durationSeconds * 1000);
    }

    return this.boundDevice;
  }

  private connectWebSocket() {
    if (!this.boundDevice) return;
    const wsUrl = this.gatewayUrl.replace(/^http/, 'ws') + `/ws?device=${this.boundDevice.deviceId}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.log(`WebSocket connected to gateway.`);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data.toString());
          if (msg.type === 'snapshot') {
            this.latestSnapshot = msg.data as SliceSnapshot;
            if (this.onSnapshotCb) this.onSnapshotCb(this.latestSnapshot);
          } else if (msg.type === 'operator-demand') {
            const newRate = msg.rateKbps;
            this.log(`Received remote operator demand: ${newRate} kbps`);
            this.updateRate(newRate);
          }
        } catch {}
      };

      this.ws.onclose = () => {
        if (this.running) {
          setTimeout(() => this.connectWebSocket(), 3000);
        }
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch (e: any) {
      this.log(`WebSocket error: ${e.message}`);
    }
  }

  private startProbing() {
    this.probeTimer = setInterval(async () => {
      if (!this.boundDevice || !this.running) return;
      const seq = this.probeSeq++;
      const sentAt = Date.now();
      try {
        const res = await fetch(`${this.gatewayUrl}/probe?device=${this.boundDevice.deviceId}&seq=${seq}`, {
          cache: 'no-store',
        });
        if (res.ok) {
          const recvAt = Date.now();
          const rtt = Math.max(1, recvAt - sentAt);
          this.probeBuffer.push({
            seq,
            sentAtMs: sentAt,
            recvAtMs: recvAt,
            rttMs: rtt,
          });
        }
      } catch {}
    }, this.probeIntervalMs);

    this.flushTimer = setInterval(async () => {
      if (!this.boundDevice || !this.running || this.probeBuffer.length === 0) return;
      const batch = [...this.probeBuffer];
      this.probeBuffer = [];
      try {
        await fetch(`${this.gatewayUrl}/portal-api/probe-results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: this.boundDevice.deviceId,
            results: batch,
          }),
        });
      } catch {}
    }, 3000);
  }

  public updateRate(rateKbps: number) {
    this.rateKbps = rateKbps;
    this.startLoadStreaming(rateKbps);
  }

  private startLoadStreaming(rateKbps: number) {
    if (this.activeLoadReq) {
      this.activeLoadReq.destroy();
      this.activeLoadReq = undefined;
    }

    if (rateKbps <= 0 || !this.boundDevice) return;

    const streamUrl = new URL(
      `${this.gatewayUrl}/load/down?device=${this.boundDevice.deviceId}&rate=${rateKbps}&mode=${this.mode}`
    );

    this.activeLoadReq = http.get(streamUrl, (res) => {
      res.on('data', (chunk: Buffer) => {
        this.totalBytesReceived += chunk.length;
      });

      res.on('error', (err) => {
        if (this.running) {
          this.log(`Stream error: ${err.message}`);
        }
      });
    });

    this.activeLoadReq.on('error', (err) => {
      if (this.running) {
        this.log(`Stream request error: ${err.message}`);
      }
    });
  }

  private reportStatus() {
    if (!this.latestSnapshot) return;
    const { stats, state, degradationPct, slice } = this.latestSnapshot;
    const mbRecv = (this.totalBytesReceived / 1024 / 1024).toFixed(2);
    const rtt = stats.latencyP95Ms !== null ? `${stats.latencyP95Ms.toFixed(1)}ms` : '--';
    const loss = `${stats.lossPct.toFixed(2)}%`;

    let stateStr = `[${state}]`;
    if (state === 'DEGRADED') stateStr = `[DEGRADED -${degradationPct}%]`;
    if (state === 'PROTECTED') stateStr = `[PROTECTED]`;

    this.log(
      `${stateStr} Demand: ${stats.demandKbps} kbps | Limit: ${stats.limitKbps} kbps (Base: ${slice.baselineKbps}) | Used: ${stats.usedKbps} kbps | RTT: ${rtt} | Loss: ${loss} | Rx: ${mbRecv} MB`
    );
  }

  public async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.probeTimer);
    clearInterval(this.flushTimer);
    clearInterval(this.displayTimer);
    clearTimeout(this.durationTimer);

    if (this.activeLoadReq) {
      this.activeLoadReq.destroy();
      this.activeLoadReq = undefined;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    this.log('Agent stopped gracefully.');
  }
}

// CLI runner
export async function runAgentCli() {
  const args = process.argv.slice(2);
  const getArg = (flag: string, fallback?: string): string => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]!;
    return fallback || '';
  };

  const code = getArg('--code');
  if (!code) {
    console.error('Usage: tsx apps/agent/src/index.ts --code <JOIN_CODE> [options]');
    console.error('Options:');
    console.error('  --gateway <url>       Gateway URL (default: http://127.0.0.1:8080)');
    console.error('  --code <code>         Slice join code (e.g. CLN101, FAC201, CAN701)');
    console.error('  --name <nickname>     Device nickname (default: hostname-Agent)');
    console.error('  --rate <kbps>         Initial load rate in kbps (default: 50)');
    console.error('  --mode <local|net>    Load mode: local or internet (default: local)');
    console.error('  --duration <sec>      Duration in seconds (default: 0 = indefinite)');
    console.error('  --probe-interval <ms> Active RTT probe interval (default: 1000)');
    process.exit(1);
  }

  const gatewayUrl = getArg('--gateway', 'http://127.0.0.1:8080');
  const name = getArg('--name', `${os.hostname()}-Agent`);
  const rate = parseInt(getArg('--rate', '50'), 10);
  const mode = (getArg('--mode', 'local') === 'internet' ? 'internet' : 'local') as 'local' | 'internet';
  const durationSeconds = parseInt(getArg('--duration', '0'), 10);
  const probeIntervalMs = parseInt(getArg('--probe-interval', '1000'), 10);

  const agent = new SliceAgent({
    gatewayUrl,
    code,
    name,
    rate,
    mode,
    durationSeconds,
    probeIntervalMs,
    headless: true,
  });

  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT. Shutting down agent...');
    await agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM. Shutting down agent...');
    await agent.stop();
    process.exit(0);
  });

  try {
    await agent.start();
  } catch (err: any) {
    console.error('Fatal agent error:', err.message);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test' && (process.argv[1]?.includes('agent') || process.argv.includes('--code'))) {
  runAgentCli();
}
