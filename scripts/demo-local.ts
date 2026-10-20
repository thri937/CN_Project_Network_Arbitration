/**
 * Headless local demonstration of the real-network testbed: TC1–TC6 on one laptop.
 *
 * Starts the slice gateway and the controller in this process, seeds the SAME 7-department
 * testbed a hotspot session uses (apps/controller/src/testbed/catalogue.ts), and drives 7 slice
 * agents over real TCP on localhost. Every check below is made on the gateway's measurements.
 *
 * Traffic stays on the laptop (loopback), so this tests the gateway, the control loop and the
 * engine — not Wi-Fi. Run the same scenarios with real devices for Wi-Fi results.
 *
 * Usage (after `npm run build`):
 *   npm run demo:local             full run, about 6 minutes
 *   npm run demo:local -- --quick  shorter TC6 windows, about 4 minutes
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const QUICK = process.argv.includes('--quick');

// After a cut the shared link runs at ~97 % of capacity, so a full root queue needs ~15–20 s
// to drain. Steady-state checks wait this long after limits change.
const SETTLE_S = 25;
// TC6 windows: a warm-up lets queues fill (OFF) or drain (ON) before anything is measured.
const TC6_WARMUP_S = QUICK ? 20 : SETTLE_S;
const TC6_MEASURE_S = QUICK ? 20 : 40;

const GATEWAY_PORT = 8192;
const SOUTHBOUND_PORT = 9192;

// Configure BEFORE the controller and gateway modules load: they read the environment at import.
Object.assign(process.env, {
  DATASTORE_DRIVER: 'memory',
  MEMORY_STORE_PERSIST: 'false',
  MEMORY_STORE_DIR: path.resolve(os.tmpdir(), `cn-demo-${Date.now()}`),
  GATEWAY_LAN_PORT: String(GATEWAY_PORT),
  GATEWAY_SOUTHBOUND_PORT: String(SOUTHBOUND_PORT),
  GATEWAY_TOKEN: 'demo-local-gateway-token',
  GATEWAY_URL: `http://127.0.0.1:${SOUTHBOUND_PORT}`,
  GATEWAY_PROXY_ENABLED: 'false',
  NETWORK_TOTAL_CAPACITY_MBPS: '1000',
  NETWORK_RESERVED_CAPACITY_MBPS: '50',
  TELEMETRY_PROVIDER: 'gateway',
  AUTO_ARBITRATION: 'true',
  TELEMETRY_TICK_MS: '2000',
  CAPACITY_TICK_MS: '2000',
  CONTENTION_SCAN_MS: '2000',
  LOG_LEVEL: 'warn',
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Stats {
  code: string;
  atMs: number;
  demandKbps: number;
  limitKbps: number;
  usedKbps: number;
  droppedKbps: number;
  latencyP95Ms: number | null;
  lossPct: number;
}

interface MeasuredWindow {
  phase: string;
  atMs: number;
  stats: Map<string, Stats>;
}

interface Check {
  label: string;
  ok: boolean;
}

interface Result {
  id: string;
  name: string;
  passed: boolean;
  checks: Check[];
}

const SHORT: Record<string, string> = {
  'patient-telemetry': 'Clinic',
  'factory-automation': 'Factory',
  'lab-instrumentation': 'Lab',
  'warehouse-operations': 'Warehouse',
  cctv: 'CCTV',
  'office-wi-fi': 'Office',
  'canteen-signage': 'Canteen',
};

const COMPLIANCE_CEILING: Record<string, number> = { LIFE_SAFETY: 0, REGULATED: 20, CONTRACTUAL: 60 };

async function load(modulePath: string): Promise<any> {
  const full = path.resolve(__dirname, '..', modulePath);
  if (!fs.existsSync(full)) {
    console.error(`Missing ${modulePath}. Run "npm run build" first.`);
    process.exit(1);
  }
  return import(pathToFileURL(full).href);
}

async function main(): Promise<void> {
  const { createGateway } = await load('apps/gateway/dist/index.js');
  const { SliceAgent } = await load('apps/agent/dist/index.js');
  const { buildContainer } = await load('apps/controller/dist/bootstrap.js');
  const { TelemetryProviderKind } = await load('apps/controller/dist/config/env.js');
  const { SYSTEM_ACTOR } = await load('apps/controller/dist/types/common.js');
  const catalogue = await load('apps/controller/dist/testbed/catalogue.js');
  const recorder = await load('apps/controller/dist/testbed/experimentRecorder.js');

  console.log('========================================================================');
  console.log('  Real-Network Testbed — local demo (TC1–TC6, loopback, 1 Mbps link)');
  console.log('========================================================================\n');

  const gateway = await createGateway();
  const container = await buildContainer({
    headless: false,
    datastore: { memory: { persist: false } },
    telemetry: { kind: TelemetryProviderKind.GATEWAY },
  });
  const provider = container.telemetryProvider;

  /* ---- Seed the testbed exactly as `npm run seed` does ----------------- */

  const items: any[] = [];
  const baseline = new Map<string, number>();
  const lowestLimit = new Map<string, number>();
  const slaLatency = new Map<string, number>();

  for (const definition of catalogue.testbedScenario(1000)) {
    const { slices, ...department } = definition;
    const dept = await container.services.departments.create(department, SYSTEM_ACTOR);
    const ceiling = Math.min(
      definition.maxAllowedDegradationPercent,
      COMPLIANCE_CEILING[definition.complianceLevel] ?? 100,
    );
    for (const sliceDef of slices) {
      await container.services.slices.create({ ...sliceDef, departmentId: dept.id }, SYSTEM_ACTOR);
      const item = catalogue.gatewayCatalogueItem(definition.name, sliceDef);
      items.push(item);
      baseline.set(item.code, item.baselineKbps);
      lowestLimit.set(item.code, Math.max(item.floorKbps, item.baselineKbps * (1 - ceiling / 100)));
      slaLatency.set(item.code, item.slaTargets.latencyMs);
    }
  }
  // Start the control loop (telemetry, contention scan, arbitration, recovery), then send the
  // gateway the catalogue with department names.
  await container.startJobs();
  await provider.pushCatalogue(items);
  const totalBaseline = items.reduce((t, i) => t + i.baselineKbps, 0);
  console.log(`✓ Seeded 7 departments / 7 slices: ${totalBaseline} kbps of baselines on a 950 kbps link\n`);

  /* ---- Agents (one per slice) ------------------------------------------ */

  const agents = new Map<string, any>();
  for (const item of items) {
    const agent = new SliceAgent({
      gatewayUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
      code: item.joinCode,
      name: `${SHORT[item.code]}-agent`,
      rate: 0,
      probeIntervalMs: 500,
      headless: true,
      onLog: () => undefined,
    });
    await agent.start();
    agents.set(item.code, agent);
  }

  const setDemand = (fraction: (code: string) => number) => {
    for (const [code, agent] of agents) agent.updateRate(Math.round(baseline.get(code)! * fraction(code)));
  };

  /* ---- Recording: one row set per gateway window ------------------------ */

  const expDir = path.resolve(__dirname, '../experiments');
  fs.mkdirSync(expDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvPath = path.join(expDir, `${stamp}-demo-local.csv`);
  const csv = fs.createWriteStream(csvPath);
  csv.write(`${recorder.EXPERIMENT_CSV_HEADER}\n`);

  let phase = 'setup';
  const windows: MeasuredWindow[] = [];
  const startedAt = Date.now();
  let lastWindowAt = 0;

  const poll = setInterval(() => {
    provider
      .readStats()
      .then((stats: Stats[]) => {
        const at = Math.max(0, ...stats.map((s) => s.atMs));
        if (stats.length === 0 || at <= lastWindowAt) return;
        lastWindowAt = at;
        windows.push({ phase, atMs: at, stats: new Map(stats.map((s) => [s.code, s])) });
        const open = container.services.contention.getOpenEvent();
        const rows: string[] = recorder.experimentRows(stats, {
          tMs: at - startedAt,
          scenario: phase,
          arbitrationOn: container.autoArbitration.enabled,
          contentionState: open?.status ?? 'NONE',
          decisionId: open?.decisionIds[open.decisionIds.length - 1] ?? '',
        });
        for (const row of rows) csv.write(`${row}\n`);
      })
      .catch(() => undefined);
  }, 500);

  const latest = () => windows[windows.length - 1]?.stats ?? new Map<string, Stats>();
  const lastWindows = (p: string, n: number) => windows.filter((w) => w.phase === p).slice(-n);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

  const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutS: number) => {
    const until = Date.now() + timeoutS * 1000;
    while (Date.now() < until) {
      if (await condition()) return true;
      await sleep(500);
    }
    return false;
  };

  const decisions = async (): Promise<any[]> => container.services.arbitration.recent(50);
  const decisionCount = async () => (await decisions()).length;
  const limitsAtBaseline = () => [...baseline].every(([code, b]) => latest().get(code)?.limitKbps === b);
  const withinBounds = () => items.every((i) => (latest().get(i.code)?.limitKbps ?? 0) >= lowestLimit.get(i.code)! - 1);

  /** Restore every degraded slice through the administrator override, as an operator would. */
  const restoreAll = async (reason: string) => {
    for (const d of await decisions()) {
      if (d.recoveryStatus !== 'RECOVERED' && d.degradedSliceIds?.length) {
        await container.services.arbitration.override(d.id, { reason, restoreAll: true }, SYSTEM_ACTOR);
      }
    }
    await waitFor(limitsAtBaseline, 10);
  };

  /** Used rate within ±tol of what the slice can carry: the smaller of its demand and limit. */
  const carriesWhatItShould = (ws: MeasuredWindow[], code: string, tol = 0.1) => {
    const used = mean(ws.map((w) => w.stats.get(code)?.usedKbps ?? 0));
    const s = ws[ws.length - 1]?.stats.get(code);
    if (!s) return false;
    const expected = Math.min(s.demandKbps, s.limitKbps);
    return Math.abs(used - expected) <= Math.max(3, expected * tol);
  };

  const latencyWithinSla = (ws: MeasuredWindow[], codes: string[]) =>
    codes.every((c) =>
      ws.every((w) => {
        const p95 = w.stats.get(c)?.latencyP95Ms;
        return p95 !== null && p95 !== undefined && p95 <= slaLatency.get(c)!;
      }),
    );

  const results: Result[] = [];
  const report = (id: string, name: string, checks: Check[]) => {
    const passed = checks.every((c) => c.ok);
    results.push({ id, name, passed, checks });
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${id} ${name}`);
    for (const c of checks) console.log(`        ${c.ok ? '✓' : '✗'} ${c.label}`);
    console.log('');
  };

  const NORMAL = 0.55;
  const LUNCH_RUSH: Record<string, number> = {
    'canteen-signage': 2.0,
    'office-wi-fi': 1.0,
    cctv: 1.0,
    'warehouse-operations': 0.8,
  };
  const lunchRush = (code: string) => LUNCH_RUSH[code] ?? NORMAL;
  const PROTECTED = ['patient-telemetry', 'factory-automation', 'lab-instrumentation'];

  let tc6Table: string[] = [];

  try {
    /* TC1 — normal day ------------------------------------------------------- */
    phase = 'TC1';
    console.log('▶ TC1 Normal day: every slice at 55 % of baseline (≈814 kbps on 950 kbps)');
    const before1 = await decisionCount();
    setDemand(() => NORMAL);
    await sleep(16_000);
    const tc1 = lastWindows('TC1', 3);
    report('TC1', 'Normal day', [
      { label: 'no contention opened', ok: container.services.contention.getOpenEvent() === null },
      { label: 'no arbitration decision', ok: (await decisionCount()) === before1 },
      { label: 'every slice carries its demand (±10 %)', ok: items.every((i) => carriesWhatItShould(tc1, i.code)) },
      {
        label: 'loss under 1 % on every slice',
        ok: tc1.length > 0 && tc1.every((w) => [...w.stats.values()].every((s) => s.lossPct < 1)),
      },
    ]);

    /* TC2 — canteen flood, contained ------------------------------------------ */
    phase = 'TC2';
    console.log('▶ TC2 Canteen flood: Canteen asks for 280 kbps (limit 140), others normal');
    setDemand((c) => (c === 'canteen-signage' ? 2.0 : NORMAL));
    await sleep(16_000);
    const tc2 = lastWindows('TC2', 3);
    const canteenUsed = mean(tc2.map((w) => w.stats.get('canteen-signage')?.usedKbps ?? 0));
    report('TC2', 'Canteen flood contained', [
      { label: `Canteen held at its 140 kbps limit (used ${canteenUsed.toFixed(0)} kbps)`, ok: canteenUsed <= 147 },
      { label: 'no slice limit changed (current limits already fit the link)', ok: limitsAtBaseline() },
      {
        label: 'other slices carry their demand (±10 %)',
        ok: items.filter((i) => i.code !== 'canteen-signage').every((i) => carriesWhatItShould(tc2, i.code)),
      },
    ]);

    /* TC3 — lunch-hour rush -------------------------------------------------- */
    phase = 'TC3';
    console.log('▶ TC3 Lunch-hour rush: Canteen 200 %, Office/CCTV 100 %, Warehouse 80 %, rest 55 %');
    const before3 = await decisionCount();
    setDemand(lunchRush);
    const opened = await waitFor(() => container.services.contention.getOpenEvent() !== null, 12);
    const decided = await waitFor(async () => (await decisionCount()) > before3, 30);
    const applied = await waitFor(() => !limitsAtBaseline(), 10);
    await sleep(SETTLE_S * 1000);
    const tc3 = lastWindows('TC3', 3);
    const s3 = latest();
    const degraded3 = items.filter((i) => (s3.get(i.code)?.limitKbps ?? 0) < i.baselineKbps);
    report('TC3', 'Lunch-hour rush', [
      { label: 'contention opened', ok: opened },
      { label: 'engine decided and the gateway enforced new limits', ok: decided && applied },
      { label: 'Clinic not cut', ok: s3.get('patient-telemetry')?.limitKbps === 60 },
      { label: 'no slice below its floor or past its ceiling', ok: withinBounds() },
      {
        label: `degraded slices (${degraded3.map((i) => SHORT[i.code]).join(', ') || 'none'}) run at their new limits (±10 %)`,
        ok: degraded3.length > 0 && degraded3.every((i) => carriesWhatItShould(tc3, i.code)),
      },
      { label: 'Clinic, Factory and Lab latency p95 within their SLA targets', ok: latencyWithinSla(tc3, PROTECTED) },
    ]);

    /* TC4 — everyone at peak --------------------------------------------------- */
    phase = 'TC4';
    console.log('▶ TC4 Everyone at peak: all slices at 100 % (1,480 kbps on 950 kbps)');
    const before4 = await decisionCount();
    setDemand(() => 1.0);
    const partial = await waitFor(async () => {
      const all = await decisions();
      return all.slice(0, all.length - before4).some((d) => d.verdict === 'PARTIAL');
    }, 45);
    await sleep(4000);
    report('TC4', 'Everyone at peak', [
      { label: 'engine reports PARTIAL (the ceilings leave a shortfall) and escalates', ok: partial },
      { label: 'Clinic not cut', ok: latest().get('patient-telemetry')?.limitKbps === 60 },
      { label: 'no slice below its floor or past its ceiling', ok: withinBounds() },
    ]);

    /* TC5 — recovery ------------------------------------------------------------ */
    phase = 'TC5';
    console.log('▶ TC5 Recovery: back to 55 %, contention closes, operator restores');
    setDemand(() => NORMAL);
    const closed = await waitFor(() => container.services.contention.getOpenEvent() === null, 20);
    const pending = (await decisions()).filter((d) => d.degradedSliceIds?.length && d.recoveryStatus !== 'RECOVERED');
    const scheduled = pending.every(
      (d) => typeof d.nextRecoveryAtMs === 'number' || ['PENDING', 'IN_PROGRESS', 'EXTENDED'].includes(d.recoveryStatus),
    );
    await restoreAll('demo: restore after recovery test');
    report('TC5', 'Recovery', [
      { label: 'contention closed after demand fell', ok: closed },
      { label: 'automatic recovery is scheduled for every degraded slice', ok: pending.length > 0 && scheduled },
      { label: 'administrator override restores every slice to baseline', ok: limitsAtBaseline() },
    ]);

    /* TC6 — A/B: arbitration OFF vs ON under the lunch-hour rush ---------------- */
    console.log(`▶ TC6 A/B under the lunch-hour rush: ${TC6_WARMUP_S} s warm-up + ${TC6_MEASURE_S} s measured, OFF then ON`);
    container.autoArbitration.enabled = false;
    phase = 'TC6-OFF-warmup';
    setDemand(lunchRush);
    await sleep(TC6_WARMUP_S * 1000);
    phase = 'TC6-OFF';
    await sleep(TC6_MEASURE_S * 1000);

    const before6 = await decisionCount();
    container.autoArbitration.enabled = true;
    phase = 'TC6-ON-warmup';
    const decided6 = await waitFor(async () => (await decisionCount()) > before6 && !limitsAtBaseline(), 30);
    await sleep(TC6_WARMUP_S * 1000);
    phase = 'TC6-ON';
    await sleep(TC6_MEASURE_S * 1000);

    const off = windows.filter((w) => w.phase === 'TC6-OFF');
    const on = windows.filter((w) => w.phase === 'TC6-ON');
    const metric = (ws: MeasuredWindow[], code: string, f: (s: Stats) => number | null) =>
      mean(
        ws
          .map((w) => w.stats.get(code))
          .filter((s): s is Stats => s !== undefined)
          .map(f)
          .filter((v): v is number => v !== null),
      );
    const fmt = (v: number, digits = 0) => (Number.isNaN(v) ? '—' : v.toFixed(digits));

    tc6Table = [
      '| Slice | Latency p95 OFF (ms) | Latency p95 ON (ms) | Loss OFF (%) | Loss ON (%) | Used OFF (kbps) | Used ON (kbps) | Limit ON (kbps) |',
      '|---|---:|---:|---:|---:|---:|---:|---:|',
      ...items.map((item) => {
        const c = item.code;
        return (
          `| ${item.name} | ${fmt(metric(off, c, (s) => s.latencyP95Ms))} | ${fmt(metric(on, c, (s) => s.latencyP95Ms))} | ` +
          `${fmt(metric(off, c, (s) => s.lossPct), 2)} | ${fmt(metric(on, c, (s) => s.lossPct), 2)} | ` +
          `${fmt(metric(off, c, (s) => s.usedKbps))} | ${fmt(metric(on, c, (s) => s.usedKbps))} | ` +
          `${on[on.length - 1]?.stats.get(c)?.limitKbps ?? '—'} |`
        );
      }),
    ];

    report('TC6', 'A/B arbitration OFF vs ON', [
      { label: `measured ${off.length} OFF and ${on.length} ON windows`, ok: off.length >= 5 && on.length >= 5 },
      { label: 'engine decided once switched ON', ok: decided6 },
      {
        label: 'Clinic, Factory and Lab: lower latency p95 with arbitration ON',
        ok: PROTECTED.every((c) => metric(on, c, (s) => s.latencyP95Ms) < metric(off, c, (s) => s.latencyP95Ms)),
      },
      {
        label: 'Clinic, Factory and Lab: loss no higher with arbitration ON',
        ok: PROTECTED.every((c) => metric(on, c, (s) => s.lossPct) <= metric(off, c, (s) => s.lossPct) + 0.1),
      },
      { label: 'Clinic, Factory and Lab within their latency SLA with arbitration ON', ok: latencyWithinSla(on, PROTECTED) },
      { label: 'Clinic not cut', ok: latest().get('patient-telemetry')?.limitKbps === 60 },
    ]);

    console.log('  TC6 means over the measured windows only:\n');
    for (const line of tc6Table) console.log(`  ${line}`);
    console.log('');
  } finally {
    clearInterval(poll);
    csv.end();
    for (const agent of agents.values()) await agent.stop().catch(() => undefined);
    await container.shutdown();
    await gateway.stop();
  }

  const summaryPath = csvPath.replace(/\.csv$/, '-summary.md');
  fs.writeFileSync(
    summaryPath,
    [
      `# demo:local results — ${new Date().toISOString()}`,
      '',
      'Loopback run (one laptop, no Wi-Fi). 1 Mbps link (950 kbps offered), 2 s measurement windows,',
      `seeded 7-slice testbed. TC6: ${TC6_WARMUP_S} s warm-up, then ${TC6_MEASURE_S} s measured, arbitration OFF then ON,`,
      'same lunch-hour-rush load.',
      '',
      '## Test cases',
      '',
      ...results.flatMap((r) => [
        `- **${r.id} ${r.name}: ${r.passed ? 'PASS' : 'FAIL'}**`,
        ...r.checks.map((c) => `  - ${c.ok ? '✓' : '✗'} ${c.label}`),
      ]),
      '',
      '## TC6 — arbitration OFF vs ON',
      '',
      ...tc6Table,
      '',
      `Raw data: \`${path.basename(csvPath)}\``,
      '',
    ].join('\n'),
  );

  const failed = results.filter((r) => !r.passed);
  console.log('========================================================================');
  for (const r of results) console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}`);
  console.log('========================================================================');
  console.log(failed.length === 0 ? '  All 6 test cases passed.' : `  ${failed.length} test case(s) failed.`);
  console.log(`  CSV:     ${csvPath}`);
  console.log(`  Summary: ${summaryPath}\n`);
  process.exit(failed.length === 0 && results.length === 6 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal demo error:', err);
  process.exit(1);
});
