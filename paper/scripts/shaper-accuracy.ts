/**
 * Shaper accuracy for the paper: a saturated slice (demand = 2 x limit) on an uncongested link,
 * 10 s of virtual time after a 1 s warm-up, with uneven ticks like Windows timers (20/35/50 ms).
 * Prints CSV: limit_kbps,measured_kbps,error_pct
 *
 *   npx tsx paper/scripts/shaper-accuracy.ts
 */
import { ShaperScheduler } from '../../apps/gateway/src/shaper/scheduler.js';
import { LoadSession } from '../../apps/gateway/src/sessions/loadSession.js';

const rates = [20, 28, 60, 140, 380, 950];
console.log('limit_kbps,measured_kbps,error_pct');
for (const limit of rates) {
  const scheduler = new ShaperScheduler({ totalCapacityKbps: 1000, reservedCapacityKbps: 50, tickMs: 20, queueSeconds: 0.5, rootDiscipline: 'fifo' });
  scheduler.registerSlice({
    code: 's', name: 's', department: 'd', sNssai: { sst: 1 }, profile: 'EMBB',
    baselineKbps: limit, floorKbps: 1, burstKbps: limit * 2, currentLimitKbps: limit,
    slaTargets: { latencyMs: 100, jitterMs: 10, lossPct: 1, minThroughputKbps: 1, availabilityPct: 99 },
    joinCode: 'S00001',
  } as any);
  let sent = 0;
  const res: any = { write: (c: Buffer) => ((sent += c.length), true), on: () => {}, end: () => {} };
  scheduler.addSession(new LoadSession({ sessionId: 'x', deviceId: 'd', sliceCode: 's', initialRateKbps: limit * 2, mode: 'local', res, onClose: () => {} } as any));
  const dts = [0.02, 0.035, 0.05];
  for (let i = 0; i < 40; i++) scheduler.step(dts[i % 3]!);
  sent = 0;
  let t = 0;
  for (let i = 0; t < 10 - 1e-9; i++) { const dt = dts[i % 3]!; scheduler.step(dt); t += dt; }
  const kbps = (sent * 8) / (t * 1000);
  console.log(`${limit},${kbps.toFixed(2)},${(((kbps - limit) / limit) * 100).toFixed(2)}`);
}
