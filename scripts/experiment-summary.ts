import fs from 'node:fs';
import path from 'node:path';

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function analyzeExperimentCsv(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  if (lines.length <= 1) {
    return 'Empty or invalid experiment CSV file.';
  }

  const header = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const parts = line.split(',').map((p) => p.trim());
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h] = parts[i] || '';
    });
    return obj;
  });

  // Group by (arbitration_on, slice)
  type GroupKey = string;
  const groups: Record<
    GroupKey,
    {
      arbitrationOn: string;
      slice: string;
      latencies: number[];
      losses: number[];
      demands: number[];
      limits: number[];
      useds: number[];
    }
  > = {};

  for (const r of rows) {
    const arb = r.arbitration_on === 'true' || r.arbitration_on === '1' ? 'ON' : 'OFF';
    const slice = r.slice || 'unknown';
    const key = `${arb}__${slice}`;
    if (!groups[key]) {
      groups[key] = {
        arbitrationOn: arb,
        slice,
        latencies: [],
        losses: [],
        demands: [],
        limits: [],
        useds: [],
      };
    }

    const lat = parseFloat(r.latency_p95_ms || '0');
    if (!isNaN(lat) && lat > 0) groups[key]!.latencies.push(lat);

    const loss = parseFloat(r.loss_pct || '0');
    if (!isNaN(loss)) groups[key]!.losses.push(loss);

    const demand = parseFloat(r.demand_kbps || '0');
    if (!isNaN(demand)) groups[key]!.demands.push(demand);

    const limit = parseFloat(r.limit_kbps || '0');
    if (!isNaN(limit)) groups[key]!.limits.push(limit);

    const used = parseFloat(r.used_kbps || '0');
    if (!isNaN(used)) groups[key]!.useds.push(used);
  }

  let md = `# Experiment Summary: ${path.basename(filePath)}\n\n`;
  md += `Total Data Points: ${rows.length}\n\n`;
  md += `| Arbitration | Slice | Mean Latency (ms) | p95 Latency (ms) | Mean Loss (%) | Mean Demand (kbps) | Mean Used (kbps) | Used / Limit Ratio |\n`;
  md += `|---|---|---:|---:|---:|---:|---:|---:|\n`;

  for (const g of Object.values(groups)) {
    const meanLat = mean(g.latencies).toFixed(1);
    const p95Lat = percentile(g.latencies, 95).toFixed(1);
    const meanLoss = mean(g.losses).toFixed(2);
    const meanDemand = mean(g.demands).toFixed(1);
    const meanUsed = mean(g.useds).toFixed(1);
    const meanLimit = mean(g.limits);
    const ratio = meanLimit > 0 ? (mean(g.useds) / meanLimit).toFixed(2) : '—';

    md += `| ${g.arbitrationOn} | ${g.slice} | ${meanLat} | ${p95Lat} | ${meanLoss}% | ${meanDemand} | ${meanUsed} | ${ratio} |\n`;
  }

  return md;
}

function main() {
  const argFile = process.argv[2];
  if (!argFile) {
    // Search for latest csv in experiments/
    const expDir = path.resolve(__dirname, '../experiments');
    if (!fs.existsSync(expDir)) {
      console.error('No experiments directory found and no CSV file specified.');
      process.exit(1);
    }
    const files = fs
      .readdirSync(expDir)
      .filter((f) => f.endsWith('.csv'))
      .map((f) => path.join(expDir, f));
    if (files.length === 0) {
      console.error('No CSV files found in experiments/ directory.');
      process.exit(1);
    }
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const latest = files[0];
    console.log(`Analyzing latest experiment file: ${latest}\n`);
    const summary = analyzeExperimentCsv(latest);
    console.log(summary);
    const mdPath = latest.replace(/\.csv$/, '-summary.md');
    fs.writeFileSync(mdPath, summary, 'utf8');
    console.log(`\nSummary saved to: ${mdPath}`);
  } else {
    const target = path.resolve(process.cwd(), argFile);
    if (!fs.existsSync(target)) {
      console.error(`File not found: ${target}`);
      process.exit(1);
    }
    const summary = analyzeExperimentCsv(target);
    console.log(summary);
    const mdPath = target.replace(/\.csv$/, '-summary.md');
    fs.writeFileSync(mdPath, summary, 'utf8');
    console.log(`\nSummary saved to: ${mdPath}`);
  }
}

if (process.argv[1]?.endsWith('experiment-summary.ts')) {
  main();
}
