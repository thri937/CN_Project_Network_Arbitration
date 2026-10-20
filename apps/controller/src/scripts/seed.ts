import crypto from 'node:crypto';
/* eslint-disable no-console */
import {
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
  SliceProfile,
  UserRole,
} from '@/constants/enums';
import { buildContainer } from '@/bootstrap';
import type { CreateDepartmentPayload } from '@/models/department.model';
import type { CreateSlicePayload } from '@/models/slice.model';
import { SYSTEM_ACTOR } from '@/types/common';
import { env, OFFERED_CAPACITY_MBPS } from '@/config/env';

/**
 * Seed 7-Department / 7-Slice Real Network Testbed.
 *
 * Scaling factor: s = NETWORK_TOTAL_CAPACITY_MBPS / 10000.
 * At 1000 kbps (1 Mbps), s = 0.1.
 */
const s = env.NETWORK_TOTAL_CAPACITY_MBPS / 10000;

interface SeedDepartment extends CreateDepartmentPayload {
  slices: (Omit<CreateSlicePayload, 'departmentId'> & { joinCode: string })[];
}

const sla = (
  latency: number,
  jitter: number,
  loss: number,
  throughput: number,
  availability: number,
) => ({
  maxLatencyMs: latency,
  maxJitterMs: jitter,
  maxPacketLossPercent: loss,
  minThroughputMbps: Math.round(throughput * s),
  availabilityPercent: availability,
});

const SCENARIO: SeedDepartment[] = [
  {
    name: 'Clinic',
    description:
      'On-site occupational health clinic. Patient monitoring and emergency comms. ' +
      'LIFE_SAFETY compliance makes its slices structurally exempt from degradation.',
    criticality: DepartmentCriticality.MISSION_CRITICAL,
    businessImportance: 100,
    downtimeCostPerMinute: 25_000,
    recoveryTolerance: RecoveryTolerance.ZERO,
    maxAllowedDegradationPercent: 0,
    complianceLevel: ComplianceLevel.LIFE_SAFETY,
    customerImpact: CustomerImpact.SEVERE_EXTERNAL,
    operationalImportance: 100,
    ownerName: 'Dr Amara Okonkwo',
    ownerEmail: 'clinical.lead@example.com',
    site: 'Building A — Clinic',
    tags: ['life-safety', 'regulated'],
    slices: [
      {
        name: 'Patient Telemetry',
        snssai: { sst: 2, sd: '000101' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: Math.round(600 * s),
        minGuaranteedMbps: Math.round(400 * s),
        maxBurstMbps: Math.round(900 * s),
        slaTargets: sla(150, 25, 0.1, 400, 99.999),
        site: 'Building A',
        tags: ['telemetry', 'life-safety', 'join:CLN101'],
        joinCode: 'CLN101',
      },
    ],
  },

  {
    name: 'Factory',
    description:
      'Primary production line. Motion control, robotics and machine vision. A stoppage ' +
      'costs £8,400 per minute of output.',
    criticality: DepartmentCriticality.MISSION_CRITICAL,
    businessImportance: 94,
    downtimeCostPerMinute: 8400,
    recoveryTolerance: RecoveryTolerance.LOW,
    maxAllowedDegradationPercent: 15,
    complianceLevel: ComplianceLevel.CONTRACTUAL,
    customerImpact: CustomerImpact.DIRECT,
    operationalImportance: 96,
    ownerName: 'Priya Raghunathan',
    ownerEmail: 'factory.ops@example.com',
    site: 'Building C — Plant',
    tags: ['ot', 'production'],
    slices: [
      {
        name: 'Factory Automation',
        snssai: { sst: 2, sd: '000201' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: Math.round(3800 * s),
        minGuaranteedMbps: Math.round(1700 * s),
        maxBurstMbps: Math.round(5800 * s),
        slaTargets: sla(180, 30, 0.1, 1500, 99.99),
        site: 'Building C',
        tags: ['ot', 'realtime', 'join:FAC201'],
        joinCode: 'FAC201',
      },
    ],
  },

  {
    name: 'Quality lab',
    description: 'Test rigs, spectrometry and batch-release documentation. Regulated output.',
    criticality: DepartmentCriticality.BUSINESS_CRITICAL,
    businessImportance: 68,
    downtimeCostPerMinute: 1600,
    recoveryTolerance: RecoveryTolerance.LOW,
    maxAllowedDegradationPercent: 20,
    complianceLevel: ComplianceLevel.REGULATED,
    customerImpact: CustomerImpact.DIRECT,
    operationalImportance: 70,
    ownerName: 'Sofia Marchetti',
    ownerEmail: 'qa.lab@example.com',
    site: 'Building B — Lab',
    tags: ['regulated', 'quality'],
    slices: [
      {
        name: 'Lab Instrumentation',
        snssai: { sst: 1, sd: '000401' },
        profile: SliceProfile.EMBB,
        baselineAllocatedMbps: Math.round(1800 * s),
        minGuaranteedMbps: Math.round(500 * s),
        maxBurstMbps: Math.round(2600 * s),
        slaTargets: sla(500, 70, 3.0, 450, 99.9),
        site: 'Building B',
        tags: ['lab', 'join:LAB401'],
        joinCode: 'LAB401',
      },
    ],
  },

  {
    name: 'Warehouse',
    description: 'Automated guided vehicles, scanners and yard management.',
    criticality: DepartmentCriticality.BUSINESS_CRITICAL,
    businessImportance: 72,
    downtimeCostPerMinute: 2100,
    recoveryTolerance: RecoveryTolerance.MODERATE,
    maxAllowedDegradationPercent: 35,
    complianceLevel: ComplianceLevel.INTERNAL,
    customerImpact: CustomerImpact.INDIRECT,
    operationalImportance: 78,
    ownerName: 'Tomas Lindqvist',
    ownerEmail: 'warehouse@example.com',
    site: 'Building D — Warehouse',
    tags: ['logistics'],
    slices: [
      {
        name: 'Warehouse Operations',
        snssai: { sst: 2, sd: '000301' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: Math.round(1600 * s),
        minGuaranteedMbps: Math.round(550 * s),
        maxBurstMbps: Math.round(2500 * s),
        slaTargets: sla(250, 40, 0.5, 450, 99.95),
        site: 'Building D',
        tags: ['logistics', 'join:WHS301'],
        joinCode: 'WHS301',
      },
    ],
  },

  {
    name: 'Security',
    description: 'CCTV, access control and building management.',
    criticality: DepartmentCriticality.BUSINESS_OPERATIONAL,
    businessImportance: 58,
    downtimeCostPerMinute: 700,
    recoveryTolerance: RecoveryTolerance.MODERATE,
    maxAllowedDegradationPercent: 40,
    complianceLevel: ComplianceLevel.CONTRACTUAL,
    customerImpact: CustomerImpact.INTERNAL_ONLY,
    operationalImportance: 66,
    ownerName: 'Grace Whitfield',
    ownerEmail: 'security@example.com',
    site: 'Site-wide',
    tags: ['security'],
    slices: [
      {
        name: 'CCTV',
        snssai: { sst: 1, sd: '000601' },
        profile: SliceProfile.EMBB,
        baselineAllocatedMbps: Math.round(2400 * s),
        minGuaranteedMbps: Math.round(600 * s),
        maxBurstMbps: Math.round(3600 * s),
        slaTargets: sla(900, 145, 8.0, 500, 99.0),
        site: 'Site-wide',
        tags: ['cctv', 'join:SEC601'],
        joinCode: 'SEC601',
      },
    ],
  },

  {
    name: 'Office IT',
    description: 'Office Wi-Fi, collaboration and back-office systems.',
    criticality: DepartmentCriticality.BUSINESS_OPERATIONAL,
    businessImportance: 52,
    downtimeCostPerMinute: 900,
    recoveryTolerance: RecoveryTolerance.MODERATE,
    maxAllowedDegradationPercent: 45,
    complianceLevel: ComplianceLevel.INTERNAL,
    customerImpact: CustomerImpact.INTERNAL_ONLY,
    operationalImportance: 55,
    ownerName: 'Daniel Osei',
    ownerEmail: 'office.it@example.com',
    site: 'Building A — Offices',
    tags: ['corporate', 'office'],
    slices: [
      {
        name: 'Office Wi-Fi',
        snssai: { sst: 1, sd: '000501' },
        profile: SliceProfile.EMBB,
        baselineAllocatedMbps: Math.round(3200 * s),
        minGuaranteedMbps: Math.round(700 * s),
        maxBurstMbps: Math.round(5000 * s),
        slaTargets: sla(600, 95, 5.0, 600, 99.5),
        site: 'Building A',
        tags: ['office', 'join:OFF501'],
        joinCode: 'OFF501',
      },
    ],
  },

  {
    name: 'Canteen',
    description:
      'Canteen menus, wayfinding and lobby displays. Provisioned as URLLC by a historical ' +
      'template — the classic case where network profile and business value disagree.',
    criticality: DepartmentCriticality.BEST_EFFORT,
    businessImportance: 8,
    downtimeCostPerMinute: 15,
    recoveryTolerance: RecoveryTolerance.HIGH,
    maxAllowedDegradationPercent: 80,
    complianceLevel: ComplianceLevel.NONE,
    customerImpact: CustomerImpact.NONE,
    operationalImportance: 10,
    ownerName: 'Canteen Facilities',
    ownerEmail: 'canteen@example.com',
    site: 'Site-wide',
    tags: ['canteen', 'best-effort'],
    slices: [
      {
        name: 'Canteen Signage',
        snssai: { sst: 2, sd: '000701' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: Math.round(1400 * s),
        minGuaranteedMbps: Math.round(280 * s),
        maxBurstMbps: Math.round(2000 * s),
        slaTargets: sla(350, 60, 10.0, 80, 98.0),
        site: 'Site-wide',
        tags: ['signage', 'join:CAN701'],
        joinCode: 'CAN701',
      },
    ],
  },
];

async function main(): Promise<void> {
  console.log(`\n▸ Seeding testbed: scale factor s = ${s} (${env.NETWORK_TOTAL_CAPACITY_MBPS} kbps total)\n`);

  const container = await buildContainer({ headless: true });

  try {
    const canonicalDeptSlugs = new Set(SCENARIO.map((d) => slugify(d.name)));
    const canonicalSliceSlugs = new Set(SCENARIO.flatMap((d) => d.slices.map((s) => slugify(s.name))));

    const existingSlicesBefore = await container.repositories.slices.listAll();
    for (const slice of existingSlicesBefore) {
      if (!canonicalSliceSlugs.has(slice.code)) {
        await container.repositories.slices.base.delete(slice.id);
        console.log(`  - removed obsolete slice ${slice.name} (${slice.code})`);
      }
    }

    const existingDeptsBefore = await container.repositories.departments.listAll();
    for (const dept of existingDeptsBefore) {
      if (!canonicalDeptSlugs.has(dept.code)) {
        await container.repositories.departments.base.delete(dept.id);
        console.log(`  - removed obsolete department ${dept.name} (${dept.code})`);
      }
    }

    const existing = await container.repositories.departments.listAll();
    const byCode = new Map(existing.map((d) => [d.code, d]));

    let departmentsCreated = 0;
    let slicesCreated = 0;
    let totalBaseline = 0;
    let totalFloor = 0;

    const gatewayCatalogueItems: any[] = [];

    for (const definition of SCENARIO) {
      const { slices, ...departmentPayload } = definition;

      let department = byCode.get(slugify(definition.name));

      if (department) {
        await container.repositories.departments.base.update(department.id, departmentPayload);
        console.log(`  = ${definition.name} (updated)`);
      } else {
        department = await container.services.departments.create(departmentPayload, SYSTEM_ACTOR);
        departmentsCreated += 1;
        console.log(
          `  + ${department.name} — ${department.criticality}, ` +
            `max degradation ${department.maxAllowedDegradationPercent}% ` +
            `(${department.complianceLevel})`,
        );
      }

      for (const sliceDefinition of slices) {
        const code = slugify(sliceDefinition.name);
        const existingSlice = await container.repositories.slices.findByCode(code);

        totalBaseline += sliceDefinition.baselineAllocatedMbps;
        totalFloor += sliceDefinition.minGuaranteedMbps;

        let activeSlice = existingSlice;
        if (existingSlice) {
          await container.repositories.slices.base.update(existingSlice.id, {
            ...sliceDefinition,
            departmentId: department.id,
          });
          console.log(`      = ${sliceDefinition.name} (updated) [join: ${sliceDefinition.joinCode}]`);
        } else {
          activeSlice = await container.services.slices.create(
            { ...sliceDefinition, departmentId: department.id },
            SYSTEM_ACTOR,
          );
          slicesCreated += 1;
          console.log(
            `      + ${activeSlice.name} — ${activeSlice.profile}, ` +
              `${activeSlice.baselineAllocatedMbps} kbps baseline / ${activeSlice.minGuaranteedMbps} kbps floor [join: ${sliceDefinition.joinCode}]`,
          );
        }

        gatewayCatalogueItems.push({
          code: slugify(sliceDefinition.name),
          name: sliceDefinition.name,
          department: definition.name,
          sNssai: sliceDefinition.snssai,
          profile: sliceDefinition.profile,
          baselineKbps: sliceDefinition.baselineAllocatedMbps,
          floorKbps: sliceDefinition.minGuaranteedMbps,
          burstKbps: sliceDefinition.maxBurstMbps,
          currentLimitKbps: sliceDefinition.baselineAllocatedMbps,
          slaTargets: {
            latencyMs: sliceDefinition.slaTargets.maxLatencyMs,
            jitterMs: sliceDefinition.slaTargets.maxJitterMs,
            lossPct: sliceDefinition.slaTargets.maxPacketLossPercent,
            minThroughputKbps: sliceDefinition.slaTargets.minThroughputMbps,
            availabilityPct: sliceDefinition.slaTargets.availabilityPercent,
          },
          joinCode: sliceDefinition.joinCode,
        });
      }
    }

    // Push catalogue to gateway if gateway adapter is configured
    if (container.telemetryProvider.name === 'gateway' && (container.telemetryProvider as any).pushCatalogue) {
      try {
        await (container.telemetryProvider as any).pushCatalogue(gatewayCatalogueItems);
        console.log('\n  ✓ Pushed slice catalogue to Slice Gateway');
      } catch (err: any) {
        console.warn('\n  ! Gateway not running; skipping direct catalogue push:', err.message);
      }
    }

    const policy = await container.services.policies.getActive();
    await container.services.settings.get();

    console.log('\n▸ Seeding users\n');
    const defaultUsers = [
      { id: 'USR-ADMIN-000001', email: 'admin@example.com', displayName: 'Administrator', role: UserRole.ADMIN },
      { id: 'USR-MNGR-000002', email: 'manager@example.com', displayName: 'Network Manager', role: UserRole.MANAGER },
      { id: 'USR-VIEW-000003', email: 'viewer@example.com', displayName: 'Operations Viewer', role: UserRole.VIEWER },
      { id: 'USR-0MS5JKZJJ-MG7K7E', email: 'jayasaivenkateshkarnasula@gmail.com', displayName: 'Jaya Sai Venkatesh', role: UserRole.ADMIN },
    ];

    for (const u of defaultUsers) {
      const existingUser = await container.repositories.users.findByEmail(u.email);
      if (!existingUser) {
        await container.repositories.users.base.create({
          id: u.id,
          subject: `dev-${crypto.createHash('sha256').update(u.email.toLowerCase()).digest('hex').slice(0, 24)}`,
          email: u.email.toLowerCase(),
          displayName: u.displayName,
          emailVerified: true,
          role: u.role,
          enabled: true,
          departmentScope: [],
          signInProvider: 'dev',
          loginCount: 0,
          notificationPreferences: { dashboard: true, email: false, minimumSeverity: 'WARNING' },
        });
        console.log(`  + ${u.displayName} (${u.email}) [${u.role}]`);
      } else {
        if (existingUser.role !== u.role) {
          await container.repositories.users.base.update(existingUser.id, { role: u.role });
          console.log(`  = ${u.displayName} (${u.email}) role updated to [${u.role}]`);
        } else {
          console.log(`  = ${u.displayName} (${u.email}) [${u.role}] (exists)`);
        }
      }
    }

    console.log('\n▸ Summary\n');
    console.log(`  departments created     ${departmentsCreated}`);
    console.log(`  slices created          ${slicesCreated}`);
    console.log(`  governing policy        ${policy.name} (revision ${policy.revision})`);
    console.log('');
    console.log(`  offered capacity        ${OFFERED_CAPACITY_MBPS} kbps`);
    console.log(
      `  committed baselines     ${totalBaseline} kbps  ` +
        `(${((totalBaseline / OFFERED_CAPACITY_MBPS) * 100).toFixed(0)}% — oversubscribed by design)`,
    );
    console.log(
      `  committed floors        ${totalFloor} kbps  ` +
        `(${((totalFloor / OFFERED_CAPACITY_MBPS) * 100).toFixed(0)}% — leaves arbitration solvable)`,
    );
    console.log('');
    console.log('  Clinic is never degraded (LIFE_SAFETY constraint),');
    console.log('  and Canteen Signage is degraded first.');
    console.log('');

    await container.shutdown();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Seeding failed:\n', error);
    await container.shutdown();
    process.exit(1);
  }
}

function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

void main();
