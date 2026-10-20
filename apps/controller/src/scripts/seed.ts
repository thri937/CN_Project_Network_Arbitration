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
import { OFFERED_CAPACITY_MBPS } from '@/config/env';

/**
 * Seed a realistic enterprise network.
 *
 * DESIGNED TO PRODUCE INTERESTING ARBITRATION, NOT JUST DATA.
 * ==========================================================
 * The scenario is a mid-sized manufacturer with an on-site clinic. It is constructed so
 * that the platform's distinguishing behaviours are visible within minutes of first run:
 *
 *   • Baselines OVERSUBSCRIBE the network (14.8 Gbps of baseline against 9.5 Gbps
 *     offered), so contention arises naturally from the diurnal load curve rather than
 *     needing fault injection.
 *   • Guaranteed floors sum to well under capacity (5.18 Gbps vs 9.5 Gbps), so arbitration
 *     always has a feasible solution. That is the admission-control invariant, demonstrated by construction.
 *   • Clinic is LIFE_SAFETY — structurally exempt. It will never be degraded, no
 *     matter how severe the contention, which is the clearest demonstration that compliance
 *     is a constraint rather than a weight.
 *   • Canteen Signage is URLLC by network profile but BEST_EFFORT by business criticality (£15/min outage).
 *     A conventional QoS controller would protect it ahead of the eMBB-profiled Quality lab.
 *     This platform does the opposite — and that inversion is the whole thesis, visible on
 *     the dashboard on day one.
 *
 * Idempotent: re-running skips anything already present.
 */

interface SeedDepartment extends CreateDepartmentPayload {
  slices: Omit<CreateSlicePayload, 'departmentId'>[];
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
  minThroughputMbps: throughput,
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
        // URLLC by network profile AND critical by business. They agree here — which makes
        // the cases where they disagree easier to see by contrast.
        snssai: { sst: 2, sd: '000101' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: 600,
        minGuaranteedMbps: 400,
        maxBurstMbps: 900,
        slaTargets: sla(5, 1, 0.001, 400, 99.999),
        site: 'Building A',
        tags: ['telemetry', 'life-safety'],
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
        name: 'Motion Control',
        snssai: { sst: 2, sd: '000201' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: 1200,
        minGuaranteedMbps: 800,
        maxBurstMbps: 1800,
        slaTargets: sla(8, 2, 0.01, 700, 99.99),
        site: 'Building C',
        tags: ['ot', 'realtime'],
      },
      {
        name: 'Machine Vision',
        snssai: { sst: 1, sd: '000202' },
        profile: SliceProfile.EMBB,
        baselineAllocatedMbps: 2600,
        minGuaranteedMbps: 900,
        maxBurstMbps: 4000,
        slaTargets: sla(30, 8, 0.2, 800, 99.9),
        site: 'Building C',
        tags: ['ot', 'vision'],
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
    // REGULATED caps degradation at 20 %, so this is the binding constraint.
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
        // eMBB profile: a conventional QoS controller would rank this BELOW Canteen
        // Signage's URLLC profile. This platform ranks it far above, on business grounds.
        snssai: { sst: 1, sd: '000401' },
        profile: SliceProfile.EMBB,
        baselineAllocatedMbps: 1800,
        minGuaranteedMbps: 500,
        maxBurstMbps: 2600,
        slaTargets: sla(40, 10, 0.3, 450, 99.9),
        site: 'Building B',
        tags: ['lab'],
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
        name: 'AGV Fleet',
        snssai: { sst: 2, sd: '000301' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: 900,
        minGuaranteedMbps: 350,
        maxBurstMbps: 1400,
        slaTargets: sla(15, 4, 0.05, 300, 99.95),
        site: 'Building D',
        tags: ['agv'],
      },
      {
        name: 'Warehouse IoT',
        snssai: { sst: 3, sd: '000302' },
        profile: SliceProfile.MMTC,
        baselineAllocatedMbps: 700,
        minGuaranteedMbps: 200,
        maxBurstMbps: 1100,
        slaTargets: sla(150, 40, 1.5, 150, 99.5),
        site: 'Building D',
        tags: ['iot'],
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
        baselineAllocatedMbps: 2400,
        minGuaranteedMbps: 600,
        maxBurstMbps: 3600,
        slaTargets: sla(80, 25, 0.8, 500, 99.0),
        site: 'Site-wide',
        tags: ['cctv'],
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
        baselineAllocatedMbps: 3200,
        minGuaranteedMbps: 700,
        maxBurstMbps: 5000,
        slaTargets: sla(50, 15, 0.5, 600, 99.5),
        site: 'Building A',
        tags: ['office'],
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
        // URLLC profile, BEST_EFFORT business value (£15/min downtime cost).
        // A QoS-priority controller protects this ahead of the Quality Lab.
        // This platform degrades it first (up to 80% cut).
        snssai: { sst: 2, sd: '000701' },
        profile: SliceProfile.URLLC,
        baselineAllocatedMbps: 1400,
        minGuaranteedMbps: 280,
        maxBurstMbps: 2000,
        slaTargets: sla(25, 8, 1.0, 80, 98.0),
        site: 'Site-wide',
        tags: ['signage'],
      },
    ],
  },
];

async function main(): Promise<void> {
  console.log('\n▸ Seeding the arbitration platform\n');

  const container = await buildContainer({ headless: true });

  try {
    // Purge any slices and departments that do not match the canonical 7-dept / 9-slice scenario
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

        if (existingSlice) {
          await container.repositories.slices.base.update(existingSlice.id, {
            ...sliceDefinition,
            departmentId: department.id,
          });
          console.log(`      = ${sliceDefinition.name} (updated)`);
          continue;
        }

        const slice = await container.services.slices.create(
          { ...sliceDefinition, departmentId: department.id },
          SYSTEM_ACTOR,
        );
        slicesCreated += 1;
        console.log(
          `      + ${slice.name} — ${slice.profile}, ` +
            `${slice.baselineAllocatedMbps} Mbps baseline / ${slice.minGuaranteedMbps} Mbps floor`,
        );
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
    console.log(`  offered capacity        ${OFFERED_CAPACITY_MBPS} Mbps`);
    console.log(
      `  committed baselines     ${totalBaseline} Mbps  ` +
        `(${((totalBaseline / OFFERED_CAPACITY_MBPS) * 100).toFixed(0)}% — oversubscribed by design)`,
    );
    console.log(
      `  committed floors        ${totalFloor} Mbps  ` +
        `(${((totalFloor / OFFERED_CAPACITY_MBPS) * 100).toFixed(0)}% — leaves arbitration solvable)`,
    );
    console.log('');
    console.log('  Watch for: Clinic is never degraded (LIFE_SAFETY constraint),');
    console.log('  and Canteen Signage is degraded before Quality lab despite carrying');
    console.log('  the higher network QoS profile.');
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
