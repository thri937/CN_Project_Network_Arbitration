import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShaperScheduler } from './shaper/scheduler.js';
import { DeviceRegistry } from './sessions/deviceRegistry.js';
import { ProbeManager } from './probes/probeManager.js';
import { SouthboundServer } from './southbound/southboundServer.js';
import { PortalServer } from './portal-api/portalServer.js';
import { ForwardProxyServer } from './proxy/forwardProxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export interface GatewayInstance {
  scheduler: ShaperScheduler;
  deviceRegistry: DeviceRegistry;
  probeManager: ProbeManager;
  southbound: SouthboundServer;
  portal: PortalServer;
  proxy: ForwardProxyServer;
  stop: () => Promise<void>;
}

export async function createGateway(): Promise<GatewayInstance> {
  const totalKbps = parseInt(process.env.NETWORK_TOTAL_CAPACITY_MBPS || '1000', 10);
  const reservedKbps = parseInt(process.env.NETWORK_RESERVED_CAPACITY_MBPS || '50', 10);
  const tickMs = parseInt(process.env.GATEWAY_TICK_MS || '20', 10);
  const queueSeconds = parseFloat(process.env.GATEWAY_QUEUE_SECONDS || '0.5');
  const rootDiscipline = (process.env.GATEWAY_ROOT_DISCIPLINE || 'fifo') as 'fifo' | 'drr';

  const southboundPort = parseInt(process.env.GATEWAY_SOUTHBOUND_PORT || '9090', 10);
  const lanPort = parseInt(process.env.GATEWAY_LAN_PORT || '8080', 10);
  const proxyPort = parseInt(process.env.GATEWAY_PROXY_PORT || '8888', 10);
  const proxyEnabled = process.env.GATEWAY_PROXY_ENABLED === 'true';
  const token = process.env.GATEWAY_TOKEN || 'change-me-long-random-gateway-token-sec-2026';
  const internetSourceUrl = process.env.INTERNET_SOURCE_URL;

  const deviceRegistry = new DeviceRegistry(15000);
  const probeManager = new ProbeManager();

  const scheduler = new ShaperScheduler({
    totalCapacityKbps: totalKbps,
    reservedCapacityKbps: reservedKbps,
    tickMs,
    queueSeconds,
    rootDiscipline,
  });

  let portalServerRef: PortalServer;

  const southbound = new SouthboundServer({
    port: southboundPort,
    token,
    scheduler,
    deviceRegistry,
    probeManager,
    statsWindowMs: parseInt(process.env.GATEWAY_STATS_WINDOW_MS || '2000', 10),
    onOperatorDemand: (sliceCode, demandKbps, mode) => {
      portalServerRef?.handleOperatorDemand(sliceCode, demandKbps, mode);
    },
    onLatestDecision: (sliceCode, decisionId, reason) => {
      portalServerRef?.recordDecision(sliceCode, decisionId, reason);
    },
  });

  const portal = new PortalServer({
    port: lanPort,
    scheduler,
    deviceRegistry,
    probeManager,
    internetSourceUrl,
  });
  portalServerRef = portal;

  const proxy = new ForwardProxyServer({
    port: proxyPort,
    enabled: proxyEnabled,
    deviceRegistry,
    scheduler,
  });

  scheduler.start();
  await southbound.start();
  await portal.start();
  if (proxyEnabled) {
    await proxy.start();
  }

  console.log(`[Slice Gateway] Online:`);
  console.log(`  Southbound API: http://127.0.0.1:${southboundPort} (Bearer auth required)`);
  console.log(`  Slice Portal & Load: http://0.0.0.0:${lanPort}`);
  if (proxyEnabled) {
    console.log(`  Forward Proxy: http://0.0.0.0:${proxyPort}`);
  }
  console.log(`  Link Offered Capacity: ${scheduler.getOfferedKbps()} kbps (Discipline: ${rootDiscipline})`);

  const stop = async () => {
    scheduler.stop();
    await southbound.stop();
    await portal.stop();
    if (proxyEnabled) {
      await proxy.stop();
    }
  };

  return {
    scheduler,
    deviceRegistry,
    probeManager,
    southbound,
    portal,
    proxy,
    stop,
  };
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  createGateway().then((gw) => {
    const shutdown = async () => {
      console.log('\nStopping Slice Gateway...');
      await gw.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
