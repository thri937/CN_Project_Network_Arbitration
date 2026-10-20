import { describe, expect, it } from 'vitest';
import { SliceProfile } from '@/constants/enums';
import {
  FaultKind,
  PROFILE_CHARACTERISTICS,
  clearFault,
  createSimulationState,
  diurnalMultiplier,
  injectFault,
  stepTraffic,
  type TrafficInputs,
} from '@/telemetry/synthetic/trafficModel';
import { mean } from '@/utils/math';

/**
 * The synthetic feed is only useful if it behaves like a network rather than like a random
 * number generator. These tests assert the physical relationships the rest of the platform
 * depends on — if any of them stops holding, arbitration is reasoning about noise.
 */

const baseInputs = (overrides: Partial<TrafficInputs> = {}): TrafficInputs => ({
  profile: SliceProfile.EMBB,
  baselineAllocatedMbps: 1000,
  allocatedMbps: 1000,
  maxBurstMbps: 1500,
  atMs: Date.UTC(2026, 5, 15, 14, 0, 0), // afternoon peak
  globalLoadMultiplier: 1,
  ...overrides,
});

/** Run `ticks` steps and return every output. */
function run(ticks: number, inputs: Partial<TrafficInputs> = {}, seed = 42) {
  const state = createSimulationState('SLC-TEST', seed, inputs.profile ?? SliceProfile.EMBB);
  return Array.from({ length: ticks }, () => stepTraffic(state, baseInputs(inputs)));
}

describe('diurnal load curve', () => {
  it('peaks in working hours and troughs overnight', () => {
    const preDawn = diurnalMultiplier(Date.UTC(2026, 5, 15, 3, 0, 0));
    const midMorning = diurnalMultiplier(Date.UTC(2026, 5, 15, 9, 0, 0));
    const afternoon = diurnalMultiplier(Date.UTC(2026, 5, 15, 15, 0, 0));

    expect(preDawn).toBeLessThan(0.4);
    expect(midMorning).toBeGreaterThan(0.9);
    expect(afternoon).toBeGreaterThan(midMorning);
  });

  it('is continuous across an hour boundary', () => {
    // A step change on the hour would show up as a visible discontinuity on every chart
    // and could trip the contention detector on the boundary alone.
    const before = diurnalMultiplier(Date.UTC(2026, 5, 15, 8, 59, 59));
    const after = diurnalMultiplier(Date.UTC(2026, 5, 15, 9, 0, 1));
    expect(Math.abs(after - before)).toBeLessThan(0.01);
  });

  it('wraps from 23:00 to 00:00 without a jump', () => {
    const lateNight = diurnalMultiplier(Date.UTC(2026, 5, 15, 23, 59, 0));
    const midnight = diurnalMultiplier(Date.UTC(2026, 5, 16, 0, 0, 0));
    expect(Math.abs(midnight - lateNight)).toBeLessThan(0.05);
  });
});

describe('demand', () => {
  it('is independent of the allocation', () => {
    // THE property that makes contention persist. If demand tracked allocation, degrading
    // a slice would erase the very signal that caused the degradation, and every
    // contention event would resolve itself instantly.
    const generous = run(200, { allocatedMbps: 1000 });
    const starved = run(200, { allocatedMbps: 200 });

    expect(mean(starved.map((s) => s.demandMbps))).toBeCloseTo(
      mean(generous.map((s) => s.demandMbps)),
      5,
    );
  });

  it('is autocorrelated rather than white noise', () => {
    // Consecutive samples must be related, otherwise the capacity trend line and the
    // contention debounce have nothing meaningful to smooth.
    const series = run(300).map((s) => s.demandMbps);

    let consecutiveDelta = 0;
    let randomPairDelta = 0;
    for (let i = 1; i < series.length; i += 1) {
      consecutiveDelta += Math.abs(series[i]! - series[i - 1]!);
      randomPairDelta += Math.abs(series[i]! - series[(i * 7 + 13) % series.length]!);
    }

    expect(consecutiveDelta).toBeLessThan(randomPairDelta * 0.7);
  });

  it('scales with the global load multiplier', () => {
    const normal = mean(run(150, { globalLoadMultiplier: 1 }).map((s) => s.demandMbps));
    const doubled = mean(run(150, { globalLoadMultiplier: 2 }).map((s) => s.demandMbps));
    expect(doubled / normal).toBeGreaterThan(1.8);
    expect(doubled / normal).toBeLessThan(2.2);
  });

  it('is never negative', () => {
    for (const sample of run(500, { globalLoadMultiplier: 0.1 })) {
      expect(sample.demandMbps).toBeGreaterThanOrEqual(0);
    }
  });

  it('reproduces exactly from the same seed', () => {
    expect(run(120, {}, 7)).toEqual(run(120, {}, 7));
  });

  it('differs between seeds', () => {
    expect(run(50, {}, 1)).not.toEqual(run(50, {}, 2));
  });
});

describe('throughput and utilisation', () => {
  it('never delivers more than the allocation', () => {
    for (const sample of run(400, { allocatedMbps: 300, globalLoadMultiplier: 3 })) {
      expect(sample.usedMbps).toBeLessThanOrEqual(300 + 1e-6);
      expect(sample.utilisation).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('delivers the full demand when capacity is ample', () => {
    const samples = run(200, { allocatedMbps: 5000, globalLoadMultiplier: 0.5 });
    for (const sample of samples) {
      expect(sample.usedMbps).toBeCloseTo(sample.demandMbps, 6);
    }
  });
});

describe('latency follows queueing theory', () => {
  it('rises sharply as utilisation approaches saturation', () => {
    // M/M/1: the knee is the whole point. A linear model would make SLA stress a
    // meaningless straight line and the arbitration engine's amplification term useless.
    const lightlyLoaded = mean(
      run(200, { allocatedMbps: 4000, globalLoadMultiplier: 0.4 }).map((s) => s.latencyMs),
    );
    const nearSaturation = mean(
      run(200, { allocatedMbps: 780, globalLoadMultiplier: 1 }).map((s) => s.latencyMs),
    );

    expect(nearSaturation).toBeGreaterThan(lightlyLoaded * 3);
  });

  it('stays finite at full saturation', () => {
    // 1/(1−ρ) diverges at ρ=1; the model caps ρ so a saturated link reports a large but
    // usable number instead of Infinity, which would poison every downstream average.
    for (const sample of run(300, { allocatedMbps: 10, globalLoadMultiplier: 5 })) {
      expect(Number.isFinite(sample.latencyMs)).toBe(true);
      expect(sample.latencyMs).toBeGreaterThan(0);
      expect(sample.latencyMs).toBeLessThan(10_000);
    }
  });

  it('reflects profile characteristics', () => {
    const urllc = mean(run(200, { profile: SliceProfile.URLLC, globalLoadMultiplier: 0.4 }).map((s) => s.latencyMs));
    const mmtc = mean(run(200, { profile: SliceProfile.MMTC, globalLoadMultiplier: 0.4 }).map((s) => s.latencyMs));

    expect(urllc).toBeLessThan(mmtc);
    expect(PROFILE_CHARACTERISTICS[SliceProfile.URLLC].baseLatencyMs).toBeLessThan(
      PROFILE_CHARACTERISTICS[SliceProfile.MMTC].baseLatencyMs,
    );
  });
});

describe('packet loss is overflow, not an independent variable', () => {
  it('stays near zero when demand fits inside the allocation', () => {
    const samples = run(300, { allocatedMbps: 6000, globalLoadMultiplier: 0.3 });
    expect(mean(samples.map((s) => s.packetLossPercent))).toBeLessThan(0.1);
  });

  it('appears in proportion to the excess when demand exceeds the allocation', () => {
    const samples = run(300, { allocatedMbps: 200, globalLoadMultiplier: 2 });
    const avgLoss = mean(samples.map((s) => s.packetLossPercent));
    expect(avgLoss).toBeGreaterThan(20);

    // Loss must be consistent with the observed excess, not sampled independently.
    for (const sample of samples) {
      const expectedOverflow =
        sample.demandMbps > 0
          ? ((sample.demandMbps - sample.usedMbps) / sample.demandMbps) * 100
          : 0;
      expect(sample.packetLossPercent).toBeGreaterThanOrEqual(expectedOverflow - 0.01);
    }
  });

  it('is bounded to a percentage', () => {
    for (const sample of run(400, { allocatedMbps: 1, globalLoadMultiplier: 8 })) {
      expect(sample.packetLossPercent).toBeGreaterThanOrEqual(0);
      expect(sample.packetLossPercent).toBeLessThanOrEqual(100);
    }
  });
});

describe('compute metrics', () => {
  it('lags throughput rather than tracking it instantly', () => {
    const state = createSimulationState('SLC-CPU', 11, SliceProfile.EMBB);
    // Warm up at low load.
    for (let i = 0; i < 50; i += 1) {
      stepTraffic(state, baseInputs({ globalLoadMultiplier: 0.2 }));
    }
    const settledCpu = state.cpuPercent;

    // A single high-load tick must not jump CPU to its new steady state.
    const afterOneTick = stepTraffic(state, baseInputs({ globalLoadMultiplier: 4 }));
    const jump = afterOneTick.cpuPercent - settledCpu;

    // Then let it converge.
    let converged = afterOneTick.cpuPercent;
    for (let i = 0; i < 60; i += 1) {
      converged = stepTraffic(state, baseInputs({ globalLoadMultiplier: 4 })).cpuPercent;
    }

    expect(converged).toBeGreaterThan(settledCpu);
    expect(jump).toBeLessThan(converged - settledCpu);
  });

  it('keeps CPU and memory inside percentage bounds', () => {
    for (const sample of run(500, { globalLoadMultiplier: 6 })) {
      expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(sample.cpuPercent).toBeLessThanOrEqual(100);
      expect(sample.memoryPercent).toBeGreaterThanOrEqual(0);
      expect(sample.memoryPercent).toBeLessThanOrEqual(100);
    }
  });

  it('scales session count with the profile', () => {
    const embb = mean(run(150, { profile: SliceProfile.EMBB }).map((s) => s.activeSessions));
    const mmtc = mean(run(150, { profile: SliceProfile.MMTC }).map((s) => s.activeSessions));
    // Massive machine-type communications: many tiny sessions per Mbps.
    expect(mmtc).toBeGreaterThan(embb);
  });
});

describe('fault injection', () => {
  it('raises demand during a DEMAND_SURGE and clears afterwards', () => {
    const state = createSimulationState('SLC-FAULT', 5, SliceProfile.EMBB);
    const before = Array.from({ length: 40 }, () => stepTraffic(state, baseInputs()).demandMbps);

    injectFault(state, FaultKind.DEMAND_SURGE, 30);
    const during = Array.from({ length: 25 }, () => stepTraffic(state, baseInputs()).demandMbps);

    // Let the fault expire.
    for (let i = 0; i < 20; i += 1) stepTraffic(state, baseInputs());
    const after = Array.from({ length: 40 }, () => stepTraffic(state, baseInputs()).demandMbps);

    expect(mean(during)).toBeGreaterThan(mean(before) * 1.5);
    expect(mean(after)).toBeLessThan(mean(during) * 0.8);
  });

  it('raises latency and loss during LINK_DEGRADATION without changing demand', () => {
    const state = createSimulationState('SLC-LINK', 9, SliceProfile.EMBB);
    const before = Array.from({ length: 40 }, () => stepTraffic(state, baseInputs()));

    injectFault(state, FaultKind.LINK_DEGRADATION, 40);
    const during = Array.from({ length: 30 }, () => stepTraffic(state, baseInputs()));

    expect(mean(during.map((s) => s.latencyMs))).toBeGreaterThan(
      mean(before.map((s) => s.latencyMs)) * 2,
    );
    // A transport impairment does not change what the sources are trying to send.
    expect(mean(during.map((s) => s.demandMbps))).toBeCloseTo(
      mean(before.map((s) => s.demandMbps)),
      -1,
    );
  });

  it('raises CPU during COMPUTE_SATURATION', () => {
    const state = createSimulationState('SLC-CPU2', 3, SliceProfile.EMBB);
    for (let i = 0; i < 40; i += 1) stepTraffic(state, baseInputs());
    const before = state.cpuPercent;

    injectFault(state, FaultKind.COMPUTE_SATURATION, 60);
    for (let i = 0; i < 40; i += 1) stepTraffic(state, baseInputs());

    expect(state.cpuPercent).toBeGreaterThan(before + 20);
  });

  it('can be cleared early', () => {
    const state = createSimulationState('SLC-CLEAR', 4, SliceProfile.EMBB);
    injectFault(state, FaultKind.DEMAND_SURGE, 500);
    expect(state.faultKind).toBe(FaultKind.DEMAND_SURGE);

    clearFault(state);
    expect(state.faultKind).toBeNull();
    expect(state.faultTicksRemaining).toBe(0);
  });
});

describe('bursts', () => {
  it('produces occasional demand spikes above the steady-state mean', () => {
    const samples = run(2000, { profile: SliceProfile.EMBB });
    const demands = samples.map((s) => s.demandMbps);
    const average = mean(demands);
    const peak = Math.max(...demands);

    // Traffic bursts are what create transient contention; without them the network would
    // be uniformly loaded and would never contend at all.
    expect(peak).toBeGreaterThan(average * 1.5);
  });
});
