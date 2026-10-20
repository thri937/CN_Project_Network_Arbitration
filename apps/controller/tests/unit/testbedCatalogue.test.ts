import { describe, expect, it } from 'vitest';
import { catalogueFromSlices, gatewayCatalogueItem, testbedScenario } from '@/testbed/catalogue';

// The gateway is an ES module built by its own tsconfig; load it at runtime (vitest transpiles it).
const GATEWAY_DEFAULTS = '../../../gateway/src/defaultCatalogue.js';

const expected = testbedScenario(1000).flatMap((d) => d.slices.map((s) => gatewayCatalogueItem(d.name, s)));

describe('testbed catalogue', () => {
  it('defines 7 slices whose baselines oversubscribe the 950 kbps link', () => {
    expect(expected).toHaveLength(7);
    expect(expected.reduce((t, s) => t + s.baselineKbps, 0)).toBe(1480);
    expect(expected.reduce((t, s) => t + s.floorKbps, 0)).toBe(473);
  });

  it('keeps the label/value mismatch the testbed demonstrates', () => {
    const byCode = new Map(expected.map((s) => [s.code, s]));
    expect(byCode.get('canteen-signage')?.profile).toBe('URLLC');
    expect(byCode.get('lab-instrumentation')?.profile).toBe('EMBB');
  });

  it("matches the gateway's start-up catalogue exactly", async () => {
    const { DEFAULT_CATALOGUE } = (await import(GATEWAY_DEFAULTS)) as { DEFAULT_CATALOGUE: unknown[] };
    expect(DEFAULT_CATALOGUE).toEqual(expected);
  });

  it('re-sends current limits, not baselines, so a cut slice stays cut', () => {
    const cat = catalogueFromSlices(
      [
        {
          code: 'canteen-signage',
          name: 'Canteen Signage',
          departmentId: 'DEP-1',
          snssai: { sst: 2, sd: '000701' },
          profile: 'URLLC',
          baselineAllocatedMbps: 140,
          allocatedMbps: 28,
          minGuaranteedMbps: 28,
          maxBurstMbps: 200,
          slaTargets: {
            maxLatencyMs: 350,
            maxJitterMs: 60,
            maxPacketLossPercent: 10,
            minThroughputMbps: 8,
            availabilityPercent: 98,
          },
          tags: ['join:CAN701'],
        } as any,
      ],
      () => 'Canteen',
    );
    expect(cat[0]).toMatchObject({ currentLimitKbps: 28, baselineKbps: 140, department: 'Canteen', joinCode: 'CAN701' });
  });
});
