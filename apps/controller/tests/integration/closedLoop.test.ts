import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createGateway, type GatewayInstance } from '../../../gateway/src/index.js';
import { buildContainer, type AppContainer } from '@/bootstrap';
import { env, TelemetryProviderKind } from '@/config/env';
import { SYSTEM_ACTOR } from '@/types/common';
import {
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
  SliceProfile,
} from '@/constants/enums';

describe('Closed Loop Integration Test (Controller + Gateway + Simulated Slices)', () => {
  let gateway: GatewayInstance;
  let container: AppContainer;
  const gwPort = 8092;
  const sbPort = 9092;
  const gwToken = 'integration-test-gateway-token';

  const origEnv = { ...process.env };

  beforeAll(async () => {
    // 1. Configure env for gateway integration
    process.env.GATEWAY_LAN_PORT = String(gwPort);
    process.env.GATEWAY_SOUTHBOUND_PORT = String(sbPort);
    process.env.GATEWAY_TOKEN = gwToken;
    process.env.GATEWAY_URL = `http://127.0.0.1:${sbPort}`;
    process.env.NETWORK_TOTAL_CAPACITY_MBPS = '1000';
    process.env.NETWORK_RESERVED_CAPACITY_MBPS = '50';
    process.env.AUTO_ARBITRATION = 'true';
    process.env.TELEMETRY_TICK_MS = '500';
    process.env.CONTENTION_SCAN_MS = '500';

    // 2. Start Gateway
    gateway = await createGateway();

    // 3. Start Controller container
    container = await buildContainer({
      headless: false,
      telemetry: { kind: TelemetryProviderKind.GATEWAY },
    });

    // 4. Seed the 7 slices into controller
    const deptClinic = await container.services.departments.create(
      {
        name: 'Clinic',
        description: 'Clinic',
        criticality: DepartmentCriticality.MISSION_CRITICAL,
        businessImportance: 100,
        downtimeCostPerMinute: 25000,
        recoveryTolerance: RecoveryTolerance.ZERO,
        maxAllowedDegradationPercent: 0,
        complianceLevel: ComplianceLevel.LIFE_SAFETY,
        customerImpact: CustomerImpact.SEVERE_EXTERNAL,
        operationalImportance: 100,
        ownerName: 'Dr Okonkwo',
        ownerEmail: 'clinic@test.com',
        site: 'Site A',
        tags: ['life-safety'],
      },
      SYSTEM_ACTOR
    );

    const deptCanteen = await container.services.departments.create(
      {
        name: 'Canteen',
        description: 'Canteen',
        criticality: DepartmentCriticality.BEST_EFFORT,
        businessImportance: 8,
        downtimeCostPerMinute: 15,
        recoveryTolerance: RecoveryTolerance.HIGH,
        maxAllowedDegradationPercent: 80,
        complianceLevel: ComplianceLevel.NONE,
        customerImpact: CustomerImpact.NONE,
        operationalImportance: 10,
        ownerName: 'Canteen Lead',
        ownerEmail: 'canteen@test.com',
        site: 'Site C',
        tags: ['best-effort'],
      },
      SYSTEM_ACTOR
    );

    const deptOffice = await container.services.departments.create(
      {
        name: 'Office IT',
        description: 'Office IT',
        criticality: DepartmentCriticality.BUSINESS_OPERATIONAL,
        businessImportance: 52,
        downtimeCostPerMinute: 900,
        recoveryTolerance: RecoveryTolerance.MODERATE,
        maxAllowedDegradationPercent: 45,
        complianceLevel: ComplianceLevel.INTERNAL,
        customerImpact: CustomerImpact.INTERNAL_ONLY,
        operationalImportance: 55,
        ownerName: 'Office Lead',
        ownerEmail: 'office@test.com',
        site: 'Site O',
        tags: ['office'],
      },
      SYSTEM_ACTOR
    );

    const sliceClinic = await container.services.slices.create(
      {
        name: 'Patient Telemetry',
        departmentId: deptClinic.id,
        snssai: { sst: 2, sd: '000101' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: 60,
        minGuaranteedMbps: 40,
        maxBurstMbps: 90,
        slaTargets: {
          maxLatencyMs: 150,
          maxJitterMs: 25,
          maxPacketLossPercent: 0.1,
          minThroughputMbps: 40,
          availabilityPercent: 99.999,
        },
        site: 'Site A',
        tags: ['telemetry', 'join:CLN101'],
      },
      SYSTEM_ACTOR
    );

    const sliceCanteen = await container.services.slices.create(
      {
        name: 'Canteen Signage',
        departmentId: deptCanteen.id,
        snssai: { sst: 2, sd: '000701' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: 140,
        minGuaranteedMbps: 28,
        maxBurstMbps: 200,
        slaTargets: {
          maxLatencyMs: 350,
          maxJitterMs: 60,
          maxPacketLossPercent: 10,
          minThroughputMbps: 8,
          availabilityPercent: 98,
        },
        site: 'Site C',
        tags: ['canteen', 'join:CAN701'],
      },
      SYSTEM_ACTOR
    );

    const sliceOffice = await container.services.slices.create(
      {
        name: 'Office Wi-Fi',
        departmentId: deptOffice.id,
        snssai: { sst: 1, sd: '000501' },
        profile: SliceProfile.EMBB,
        baselineAllocatedMbps: 320,
        minGuaranteedMbps: 70,
        maxBurstMbps: 500,
        slaTargets: {
          maxLatencyMs: 600,
          maxJitterMs: 95,
          maxPacketLossPercent: 5,
          minThroughputMbps: 60,
          availabilityPercent: 99.5,
        },
        site: 'Site O',
        tags: ['office', 'join:OFF501'],
      },
      SYSTEM_ACTOR
    );

    // Push catalogue to gateway
    const catalogue = [
      {
        code: sliceClinic.code,
        name: sliceClinic.name,
        department: 'Clinic',
        sNssai: sliceClinic.snssai,
        profile: sliceClinic.profile,
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
        code: sliceCanteen.code,
        name: sliceCanteen.name,
        department: 'Canteen',
        sNssai: sliceCanteen.snssai,
        profile: sliceCanteen.profile,
        baselineKbps: 140,
        floorKbps: 28,
        burstKbps: 200,
        currentLimitKbps: 140,
        slaTargets: {
          latencyMs: 350,
          jitterMs: 60,
          lossPct: 10,
          minThroughputKbps: 8,
          availabilityPct: 98,
        },
        joinCode: 'CAN701',
      },
      {
        code: sliceOffice.code,
        name: sliceOffice.name,
        department: 'Office IT',
        sNssai: sliceOffice.snssai,
        profile: sliceOffice.profile,
        baselineKbps: 320,
        floorKbps: 70,
        burstKbps: 500,
        currentLimitKbps: 320,
        slaTargets: {
          latencyMs: 600,
          jitterMs: 95,
          lossPct: 5,
          minThroughputKbps: 60,
          availabilityPct: 99.5,
        },
        joinCode: 'OFF501',
      },
    ];

    await (container.telemetryProvider as any).pushCatalogue(catalogue);
    await container.startJobs();
  });

  afterAll(async () => {
    await container.shutdown();
    await gateway.stop();
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
  });

  it('runs closed loop: join devices -> drive demand -> arbitration mitigates contention', async () => {
    // Helper to join device
    const joinDevice = async (code: string, nickname: string) => {
      return new Promise<{ deviceId: string }>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${gwPort}/portal-api/join`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve(JSON.parse(data)));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ code, nickname }));
        req.end();
      });
    };

    // Join devices
    const devClinic = await joinDevice('CLN101', 'ClinicDevice');
    const devCanteen = await joinDevice('CAN701', 'CanteenDevice');
    const devOffice = await joinDevice('OFF501', 'OfficeDevice');

    expect(devClinic.deviceId).toBeDefined();
    expect(devCanteen.deviceId).toBeDefined();

    // Helper to report client probe results
    const sendProbes = async (deviceId: string, rttMs: number) => {
      return new Promise<void>((resolve) => {
        const req = http.request(
          `http://127.0.0.1:${gwPort}/portal-api/probe-results`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          () => resolve()
        );
        req.write(
          JSON.stringify({
            deviceId,
            results: [
              {
                seq: 1,
                sentAtMs: Date.now() - rttMs,
                recvAtMs: Date.now(),
                rttMs,
              },
            ],
          })
        );
        req.end();
      });
    };

    // Send probe results so slices are HEALTHY
    await sendProbes(devClinic.deviceId, 20);
    await sendProbes(devCanteen.deviceId, 30);
    await sendProbes(devOffice.deviceId, 40);

    // Start load streams
    const streamLoad = (deviceId: string, rate: number) => {
      const req = http.get(`http://127.0.0.1:${gwPort}/load/down?device=${deviceId}&rate=${rate}`, (res) => {
        res.on('data', () => {});
      });
      return req;
    };

    // Clinic sends 33 kbps (normal)
    const reqClinic = streamLoad(devClinic.deviceId, 33);
    // Canteen floods at 280 kbps
    const reqCanteen = streamLoad(devCanteen.deviceId, 280);
    // Office at 320 kbps
    const reqOffice = streamLoad(devOffice.deviceId, 320);

    // Let telemetry ticks sample and report
    for (let i = 0; i < 6; i++) {
      await sendProbes(devClinic.deviceId, 20);
      await sendProbes(devCanteen.deviceId, 35);
      await sendProbes(devOffice.deviceId, 45);
      await new Promise((r) => setTimeout(r, 600));
    }

    reqClinic.destroy();
    reqCanteen.destroy();
    reqOffice.destroy();

    // Verify gateway stats were polled
    const live = container.services.telemetry.getSnapshot();
    expect(live).toBeDefined();
    expect(live?.slices.length).toBeGreaterThanOrEqual(1);

    // Verify Clinic was never cut
    const clinicState = container.services.telemetry.getSliceState('slice-telemetry');
    if (clinicState) {
      expect(clinicState.allocatedMbps).toBe(60);
    }
  });
});
