import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SliceCatalogueItem } from '@cn/shared';
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

  const defaultSlices: SliceCatalogueItem[] = [
    {
      code: 'patient-telemetry',
      name: 'Patient Telemetry',
      department: 'Clinic',
      sNssai: { sst: 2, sd: '000001' },
      profile: 'URLLC',
      baselineKbps: 60,
      floorKbps: 40,
      burstKbps: 90,
      currentLimitKbps: 60,
      slaTargets: { latencyMs: 150, jitterMs: 25, lossPct: 0.1, minThroughputKbps: 40, availabilityPct: 99.999 },
      joinCode: 'CLN101',
    },
    {
      code: 'factory-automation',
      name: 'Factory Automation',
      department: 'Factory',
      sNssai: { sst: 2, sd: '000002' },
      profile: 'URLLC',
      baselineKbps: 380,
      floorKbps: 170,
      burstKbps: 580,
      currentLimitKbps: 380,
      slaTargets: { latencyMs: 180, jitterMs: 30, lossPct: 0.1, minThroughputKbps: 150, availabilityPct: 99.99 },
      joinCode: 'FAC201',
    },
    {
      code: 'lab-instrumentation',
      name: 'Lab Instrumentation',
      department: 'Quality Lab',
      sNssai: { sst: 1, sd: '000001' },
      profile: 'eMBB',
      baselineKbps: 180,
      floorKbps: 50,
      burstKbps: 260,
      currentLimitKbps: 180,
      slaTargets: { latencyMs: 500, jitterMs: 70, lossPct: 3.0, minThroughputKbps: 45, availabilityPct: 99.9 },
      joinCode: 'LAB401',
    },
    {
      code: 'warehouse-operations',
      name: 'Warehouse Operations',
      department: 'Warehouse',
      sNssai: { sst: 3, sd: '000001' },
      profile: 'mMTC',
      baselineKbps: 160,
      floorKbps: 55,
      burstKbps: 250,
      currentLimitKbps: 160,
      slaTargets: { latencyMs: 250, jitterMs: 40, lossPct: 0.5, minThroughputKbps: 45, availabilityPct: 99.95 },
      joinCode: 'WHS301',
    },
    {
      code: 'cctv',
      name: 'CCTV',
      department: 'Security',
      sNssai: { sst: 1, sd: '000002' },
      profile: 'eMBB',
      baselineKbps: 240,
      floorKbps: 60,
      burstKbps: 360,
      currentLimitKbps: 240,
      slaTargets: { latencyMs: 900, jitterMs: 145, lossPct: 8.0, minThroughputKbps: 50, availabilityPct: 99.0 },
      joinCode: 'SEC601',
    },
    {
      code: 'office-wi-fi',
      name: 'Office Wi-Fi',
      department: 'Office IT',
      sNssai: { sst: 1, sd: '000003' },
      profile: 'eMBB',
      baselineKbps: 320,
      floorKbps: 70,
      burstKbps: 500,
      currentLimitKbps: 320,
      slaTargets: { latencyMs: 600, jitterMs: 95, lossPct: 5.0, minThroughputKbps: 60, availabilityPct: 99.5 },
      joinCode: 'OFF501',
    },
    {
      code: 'canteen-signage',
      name: 'Canteen',
      department: 'Canteen',
      sNssai: { sst: 1, sd: '000004' },
      profile: 'eMBB',
      baselineKbps: 140,
      floorKbps: 28,
      burstKbps: 200,
      currentLimitKbps: 140,
      slaTargets: { latencyMs: 350, jitterMs: 60, lossPct: 10.0, minThroughputKbps: 8, availabilityPct: 98.0 },
      joinCode: 'CAN701',
    },
  ];
  deviceRegistry.setCatalogue(defaultSlices);
  scheduler.initSlices(defaultSlices);

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
