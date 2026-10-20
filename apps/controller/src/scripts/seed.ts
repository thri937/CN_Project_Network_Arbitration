import crypto from 'node:crypto';
/* eslint-disable no-console */
import { UserRole } from '@/constants/enums';
import { buildContainer } from '@/bootstrap';
import { gatewayCatalogueItem, slugify, testbedScenario } from '@/testbed/catalogue';
import { SYSTEM_ACTOR } from '@/types/common';
import { env, OFFERED_CAPACITY_MBPS } from '@/config/env';

/**
 * Seed 7-Department / 7-Slice Real Network Testbed (definition in `testbed/catalogue.ts`).
 *
 * Scaling factor: s = NETWORK_TOTAL_CAPACITY_MBPS / 10000.
 * At 1000 kbps (1 Mbps), s = 0.1.
 */
const s = env.NETWORK_TOTAL_CAPACITY_MBPS / 10000;

const SCENARIO = testbedScenario(env.NETWORK_TOTAL_CAPACITY_MBPS);


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

    const gatewayCatalogueItems: ReturnType<typeof gatewayCatalogueItem>[] = [];

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

        gatewayCatalogueItems.push(gatewayCatalogueItem(definition.name, sliceDefinition));
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


void main();
