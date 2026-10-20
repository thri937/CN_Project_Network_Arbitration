import http from 'node:http';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:9090';
const GATEWAY_PORTAL_URL = 'http://127.0.0.1:8080';
const TOKEN = process.env.GATEWAY_TOKEN || 'change-me-long-random-gateway-token-sec-2026';

interface SliceStats {
  code: string;
  name?: string;
  latencyP95Ms: number | null;
  latencyP50Ms: number | null;
  slaLatencyTargetMs?: number;
}

export async function runCalibration(durationS = 30): Promise<{
  samples: number;
  results: { code: string; p50: number; p95: number; target: number; warning: boolean }[];
}> {
  console.log(`=== Calibrating Idle Probe Latency (${durationS}s) ===`);
  console.log('Ensure devices are joined and idle (no active load sessions)...\n');

  const slaTargets: Record<string, number> = {
    'slice-telemetry': 150,
    'slice-factory': 180,
    'slice-lab': 500,
    'slice-warehouse': 250,
    'slice-cctv': 900,
    'slice-office': 600,
    'slice-canteen': 350,
  };

  const p95History: Record<string, number[]> = {};
  const p50History: Record<string, number[]> = {};

  const iterations = Math.max(1, Math.floor(durationS / 2));

  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, 2000));

    try {
      const stats = await new Promise<any[]>((resolve, reject) => {
        const req = http.get(
          `${GATEWAY_URL}/v1/stats`,
          { headers: { Authorization: `Bearer ${TOKEN}` } },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(e);
              }
            });
          }
        );
        req.on('error', reject);
      });

      for (const s of stats) {
        if (!p95History[s.code]) {
          p95History[s.code] = [];
          p50History[s.code] = [];
        }
        if (s.latencyP95Ms !== null && s.latencyP95Ms !== undefined) {
          p95History[s.code]!.push(s.latencyP95Ms);
        }
        if (s.latencyP50Ms !== null && s.latencyP50Ms !== undefined) {
          p50History[s.code]!.push(s.latencyP50Ms);
        }
      }
    } catch (err: any) {
      console.warn(`Sample ${i + 1}/${iterations} failed: ${err.message}`);
    }
  }

  const results: { code: string; p50: number; p95: number; target: number; warning: boolean }[] = [];

  console.log('\n--- Calibration Summary ---');
  for (const [code, p95Arr] of Object.entries(p95History)) {
    const target = slaTargets[code] || 500;
    const avgP95 = p95Arr.length > 0 ? Math.round(p95Arr.reduce((a, b) => a + b, 0) / p95Arr.length) : 0;
    const p50Arr = p50History[code] || [];
    const avgP50 = p50Arr.length > 0 ? Math.round(p50Arr.reduce((a, b) => a + b, 0) / p50Arr.length) : 0;

    const threshold = target * 0.6;
    const warning = avgP95 > threshold;

    results.push({ code, p50: avgP50, p95: avgP95, target, warning });

    const status = warning
      ? `[WARN] idle p95 (${avgP95} ms) > 60% of SLA target (${target} ms)`
      : `[PASS] idle p95 (${avgP95} ms) <= 60% target (${target} ms)`;

    console.log(`${code.padEnd(20)} p50: ${avgP50.toString().padStart(4)} ms | p95: ${avgP95.toString().padStart(4)} ms | target: ${target.toString().padStart(4)} ms | ${status}`);
  }

  return { samples: iterations, results };
}

if (process.argv[1]?.endsWith('calibrate.ts')) {
  runCalibration().catch(console.error);
}
