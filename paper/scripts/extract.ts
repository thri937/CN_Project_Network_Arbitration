/**
 * Turns a demo:local CSV into the numbers and series the paper's figures use.
 *
 *   npx tsx paper/scripts/extract.ts paper/results/fifo-demo-local.csv
 *
 * Prints JSON: TC3 timing (load change → contention detected → first limit change), and the TC6
 * time series (Clinic p95 latency, link carried total) with t measured from the start of TC6.
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: extract.ts <demo-local.csv>');
const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
const cols = header!.split(',');
const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));

// Group rows into windows (one row per slice per window).
const windows = new Map<number, Record<string, string>[]>();
for (const r of rows) {
  const t = Number(r.t_ms);
  windows.set(t, [...(windows.get(t) ?? []), r]);
}
const ordered = [...windows.entries()].sort((a, b) => a[0] - b[0]);

// TC3 timing.
const tc3 = ordered.filter(([, w]) => w[0]!.scenario === 'TC3');
const t0 = tc3[0]![0];
const detected = tc3.find(([, w]) => w[0]!.contention_state !== 'NONE');
const baseline = new Map(ordered[0]![1].map((r) => [r.slice, Number(r.limit_kbps)]));
const firstCut = tc3.find(([, w]) => w.some((r) => Number(r.limit_kbps) < (baseline.get(r.slice) ?? 0) - 0.5));

// TC6 series.
const tc6 = ordered.filter(([, w]) => String(w[0]!.scenario).startsWith('TC6'));
const s0 = tc6[0]![0];
const series = tc6.map(([t, w]) => {
  const clinic = w.find((r) => r.slice === 'patient-telemetry')!;
  const factory = w.find((r) => r.slice === 'factory-automation')!;
  const canteen = w.find((r) => r.slice === 'canteen-signage')!;
  return {
    t: Math.round((t - s0) / 100) / 10,
    phase: w[0]!.scenario,
    clinicP95: num(clinic.latency_p95_ms),
    factoryP95: num(factory.latency_p95_ms),
    canteenP95: num(canteen.latency_p95_ms),
    carried: w.reduce((sum, r) => sum + Number(r.used_kbps), 0),
    demand: w.reduce((sum, r) => sum + Number(r.demand_kbps), 0),
    canteenLimit: Number(canteen.limit_kbps),
  };
});

console.log(
  JSON.stringify(
    {
      tc3: {
        windowsUntilDetected: detected ? (detected[0] - t0) / 1000 : null,
        secondsUntilFirstCut: firstCut ? (firstCut[0] - t0) / 1000 : null,
      },
      tc6: series,
    },
    null,
    1,
  ),
);
