/**
 * What the link does with NO controller: every slice keeps its baseline limit, and the shared link
 * is either a plain FIFO or deficit round robin weighted by limit (classic fair queueing).
 * Runs the real gateway scheduler on a virtual clock: TC3 and TC4 demand, 20 s warm-up, 40 s
 * measured, one probe per slice every 0.5 s.
 * Prints CSV: scenario,discipline,slice,demand_kbps,carried_kbps,probe_p95_ms,probes_lost_pct
 *
 *   npx tsx paper/scripts/no-arbitration.ts
 */
import { ShaperScheduler } from '../../apps/gateway/src/shaper/scheduler.js';
import { LoadSession } from '../../apps/gateway/src/sessions/loadSession.js';
import { DEFAULT_CATALOGUE } from '../../apps/gateway/src/defaultCatalogue.js';

const scenarios: Record<string, Record<string, number>> = {
  TC3: { 'canteen-signage': 2, 'office-wi-fi': 1, cctv: 1, 'warehouse-operations': 0.8 },
  TC4: Object.fromEntries(DEFAULT_CATALOGUE.map((s) => [s.code, 1])),
};
const DT = 0.02;

console.log('scenario,discipline,slice,demand_kbps,carried_kbps,probe_p95_ms,probes_lost_pct');
for (const [scenario, fractions] of Object.entries(scenarios)) {
  for (const discipline of ['fifo', 'drr'] as const) {
    const scheduler = new ShaperScheduler({ totalCapacityKbps: 1000, reservedCapacityKbps: 50, tickMs: 20, queueSeconds: 0.5, rootDiscipline: discipline });
    const sent = new Map<string, number>();
    const delays = new Map<string, number[]>();
    const probes = new Map<string, { sent: number; answered: number }>();
    let measuring = false;
    let nowNs = 0n;

    for (const item of DEFAULT_CATALOGUE) {
      scheduler.registerSlice({ ...item });
      sent.set(item.code, 0);
      delays.set(item.code, []);
      probes.set(item.code, { sent: 0, answered: 0 });
      const res: any = {
        write: (c: Buffer) => {
          if (measuring) sent.set(item.code, sent.get(item.code)! + c.length);
          return true;
        },
        on: () => {},
        end: () => {},
      };
      const rate = item.baselineKbps * (fractions[item.code] ?? 0.55);
      scheduler.addSession(new LoadSession({ sessionId: item.code, deviceId: item.code, sliceCode: item.code, initialRateKbps: rate, mode: 'local', res, onClose: () => {} } as any));
    }
    scheduler.onTransmitProbe = (chunk) => {
      if (!measuring) return;
      delays.get(chunk.sliceCode)!.push(Number(nowNs - chunk.enqueuedAtNs) / 1e6);
      probes.get(chunk.sliceCode)!.answered++;
    };

    const steps = Math.round(60 / DT);
    for (let i = 0; i < steps; i++) {
      measuring = i >= Math.round(20 / DT);
      if (i % Math.round(0.5 / DT) === 0) {
        for (const item of DEFAULT_CATALOGUE) {
          if (measuring) probes.get(item.code)!.sent++;
          scheduler.enqueueProbeChunk(item.code, { sliceCode: item.code, data: Buffer.alloc(64), isProbe: true, enqueuedAtNs: nowNs });
        }
      }
      nowNs += BigInt(Math.floor(DT * 1e9));
      scheduler.step(DT);
    }

    for (const item of DEFAULT_CATALOGUE) {
      const d = delays.get(item.code)!.sort((a, b) => a - b);
      const p95 = d.length ? d[Math.min(d.length - 1, Math.floor(0.95 * d.length))]! : NaN;
      const p = probes.get(item.code)!;
      const demand = item.baselineKbps * (fractions[item.code] ?? 0.55);
      const carried = (sent.get(item.code)! * 8) / (40 * 1000);
      console.log(
        [scenario, discipline, item.code, demand.toFixed(0), carried.toFixed(1), p95.toFixed(0), (((p.sent - p.answered) / p.sent) * 100).toFixed(1)].join(','),
      );
    }
  }
}
