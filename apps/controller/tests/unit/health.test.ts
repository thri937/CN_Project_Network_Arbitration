import { describe, expect, it } from 'vitest';
import { HealthState } from '@/constants/enums';
import { assessHealth, type HealthInputs } from '@/telemetry/synthetic/health';
import type { SlaTargets } from '@/models/slice.model';

/**
 * Health scoring is consumed twice: by the dashboard an operator watches, and by the
 * arbitration engine's SLA-stress term. Both read the SAME function, so these tests
 * simultaneously pin what a NOC sees and what the engine believes.
 */

const urllcTargets: SlaTargets = {
  maxLatencyMs: 10,
  maxJitterMs: 2,
  maxPacketLossPercent: 0.01,
  minThroughputMbps: 100,
  availabilityPercent: 99.999,
};

const mmtcTargets: SlaTargets = {
  maxLatencyMs: 200,
  maxJitterMs: 50,
  maxPacketLossPercent: 2,
  minThroughputMbps: 10,
  availabilityPercent: 99,
};

const healthy: HealthInputs = {
  latencyMs: 2,
  jitterMs: 0.3,
  packetLossPercent: 0,
  usedMbps: 500,
  demandMbps: 500,
  cpuPercent: 25,
  memoryPercent: 40,
};

describe('SLA-relative scoring', () => {
  it('scores against the slice’s own contract, not absolute thresholds', () => {
    // 40 ms is excellent for a sensor network and catastrophic for motion control.
    // A global "latency > 30 ms is bad" rule would be wrong for most of the fleet.
    const metrics: HealthInputs = { ...healthy, latencyMs: 40, usedMbps: 50, demandMbps: 50 };

    const forUrllc = assessHealth(metrics, urllcTargets);
    const forMmtc = assessHealth(metrics, mmtcTargets);

    expect(forUrllc.breaches).toContain('latency');
    expect(forMmtc.breaches).not.toContain('latency');
    expect(forMmtc.healthScore).toBeGreaterThan(forUrllc.healthScore);
  });

  it('reports a comfortable slice as HEALTHY', () => {
    // 2 ms against a 10 ms budget is 20 % consumed, so the score is 80 by definition —
    // healthScore is exactly (1 − stress) × 100. Classification keys off stress, not the
    // score, which is why 80 is HEALTHY rather than WARNING.
    const result = assessHealth(healthy, urllcTargets);
    expect(result.health).toBe(HealthState.HEALTHY);
    expect(result.slaStress).toBeCloseTo(0.2, 5);
    expect(result.healthScore).toBeCloseTo(80, 5);
    expect(result.breaches).toEqual([]);
  });
});

describe('conjunctive scoring', () => {
  it('takes the worst dimension, never the average', () => {
    // An SLA is conjunctive: meeting throughput while breaching loss is still a breach.
    // Averaging would let one healthy dimension mask a live breach — the single most
    // dangerous thing a NOC dashboard can do.
    const oneBadDimension: HealthInputs = {
      ...healthy,
      packetLossPercent: 0.01, // exactly at the URLLC limit
    };

    const result = assessHealth(oneBadDimension, urllcTargets);
    expect(result.breakdown.packetLoss).toBe(1);
    expect(result.slaStress).toBe(1);
    // Latency and jitter are excellent, yet the score reflects the worst dimension.
    expect(result.breakdown.latency).toBeLessThan(0.3);
    expect(result.healthScore).toBe(0);
  });

  it('surfaces every breached dimension by name', () => {
    const multiBreach: HealthInputs = {
      ...healthy,
      latencyMs: 50,
      jitterMs: 8,
      packetLossPercent: 5,
    };

    const result = assessHealth(multiBreach, urllcTargets);
    expect(result.breaches).toEqual(
      expect.arrayContaining(['latency', 'jitter', 'packetLoss']),
    );
  });
});

describe('throughput stress', () => {
  it('does not penalise a slice that simply is not asking for much', () => {
    // Demand of 5 Mbps against a 100 Mbps minimum is not a breach — the slice is idle,
    // not starved. Measuring against the raw target would mark every quiet slice as sick.
    const idle: HealthInputs = { ...healthy, usedMbps: 5, demandMbps: 5 };
    const result = assessHealth(idle, urllcTargets);

    expect(result.breakdown.throughput).toBe(0);
    expect(result.breaches).not.toContain('throughput');
  });

  it('penalises a slice that is genuinely starved', () => {
    // Wants 500, receiving 20, against a 100 Mbps floor.
    const starved: HealthInputs = { ...healthy, usedMbps: 20, demandMbps: 500 };
    const result = assessHealth(starved, urllcTargets);

    expect(result.breakdown.throughput).toBeGreaterThan(0.7);
    expect(result.breaches).toContain('throughput');
  });
});

describe('compute pressure', () => {
  it('is nearly free through the normal operating range', () => {
    // Regression guard for a real defect: linear scaling made a user-plane function at
    // 40 % memory contribute 0.4 stress, dragging a slice that met every SLA target with
    // room to spare down to WARNING.
    expect(assessHealth({ ...healthy, cpuPercent: 40 }, urllcTargets).breakdown.compute).toBeLessThan(0.06);
    expect(assessHealth({ ...healthy, cpuPercent: 65 }, urllcTargets).breakdown.compute).toBeLessThan(0.08);
  });

  it('climbs steeply as saturation approaches', () => {
    const at70 = assessHealth({ ...healthy, cpuPercent: 70 }, urllcTargets).breakdown.compute;
    const at85 = assessHealth({ ...healthy, cpuPercent: 85 }, urllcTargets).breakdown.compute;
    const at95 = assessHealth({ ...healthy, cpuPercent: 95 }, urllcTargets).breakdown.compute;

    expect(at70).toBeLessThan(0.1);
    expect(at85).toBeGreaterThan(0.35);
    expect(at95).toBeGreaterThan(0.7);
    // Late-onset, not linear: the last 10 points cost more than the first 70.
    expect(at95 - at85).toBeGreaterThan(at70);
  });

  it('is monotonic in utilisation', () => {
    let previous = -1;
    for (const cpu of [0, 20, 40, 60, 70, 80, 90, 95, 100]) {
      const value = assessHealth({ ...healthy, cpuPercent: cpu }, urllcTargets).breakdown.compute;
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('never counts as an SLA breach on its own', () => {
    const saturated: HealthInputs = { ...healthy, cpuPercent: 99, memoryPercent: 99 };
    const result = assessHealth(saturated, urllcTargets);
    expect(result.breaches).toEqual([]);
    // …but it does depress the score, which is the point of a leading indicator.
    expect(result.healthScore).toBeLessThan(10);
  });
});

describe('state classification', () => {
  it('reports a live breach as at least DEGRADED regardless of score', () => {
    // A slice can sit at 82 % health while exceeding its loss target. Reporting that as
    // "healthy" would be a lie by rounding.
    const marginalBreach: HealthInputs = {
      ...healthy,
      packetLossPercent: 0.011, // just over the 0.01 limit
    };
    const result = assessHealth(marginalBreach, urllcTargets);

    expect(result.breaches).toContain('packetLoss');
    expect([HealthState.DEGRADED, HealthState.CRITICAL]).toContain(result.health);
    expect(result.health).not.toBe(HealthState.HEALTHY);
  });

  it('escalates to CRITICAL when a breach coincides with a low score', () => {
    const severe: HealthInputs = {
      ...healthy,
      latencyMs: 200,
      packetLossPercent: 40,
      usedMbps: 5,
      demandMbps: 500,
    };
    expect(assessHealth(severe, urllcTargets).health).toBe(HealthState.CRITICAL);
  });

  it('grades unbreached slices by margin', () => {
    const comfortable = assessHealth({ ...healthy, latencyMs: 1 }, urllcTargets);
    const tight = assessHealth({ ...healthy, latencyMs: 7 }, urllcTargets);

    expect(comfortable.health).toBe(HealthState.HEALTHY);
    expect(tight.health).toBe(HealthState.WARNING);
    expect(tight.healthScore).toBeLessThan(comfortable.healthScore);
  });
});

describe('boundary handling', () => {
  it('treats a zero limit as breached by any positive observation', () => {
    const zeroLoss: SlaTargets = { ...urllcTargets, maxPacketLossPercent: 0 };
    const result = assessHealth({ ...healthy, packetLossPercent: 0.001 }, zeroLoss);
    expect(result.breakdown.packetLoss).toBe(1);
    expect(result.breaches).toContain('packetLoss');
  });

  it('keeps the score inside 0–100 under extreme input', () => {
    const extreme: HealthInputs = {
      latencyMs: 100_000,
      jitterMs: 100_000,
      packetLossPercent: 100,
      usedMbps: 0,
      demandMbps: 10_000,
      cpuPercent: 100,
      memoryPercent: 100,
    };
    const result = assessHealth(extreme, urllcTargets);
    expect(result.healthScore).toBe(0);
    expect(result.slaStress).toBe(1);
  });

  it('is monotonic — worse metrics never produce a better score', () => {
    let previous = 101;
    for (const latency of [1, 3, 5, 7, 9, 11, 20, 50]) {
      const score = assessHealth({ ...healthy, latencyMs: latency }, urllcTargets).healthScore;
      expect(score).toBeLessThanOrEqual(previous);
      previous = score;
    }
  });
});
