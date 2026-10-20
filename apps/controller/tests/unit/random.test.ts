import { describe, expect, it } from 'vitest';
import { createRandom, hashSeed } from '@/utils/random';
import { mean, stdDev } from '@/utils/math';

describe('deterministic random source', () => {
  it('produces an identical stream for an identical seed', () => {
    // This is the property that makes telemetry replay possible: the same seed and the
    // same number of ticks must reproduce the same network conditions exactly.
    const a = createRandom(12345);
    const b = createRandom(12345);
    const seriesA = Array.from({ length: 200 }, () => a.next());
    const seriesB = Array.from({ length: 200 }, () => b.next());
    expect(seriesA).toEqual(seriesB);
  });

  it('produces different streams for different seeds', () => {
    const a = createRandom(1);
    const b = createRandom(2);
    expect(Array.from({ length: 20 }, () => a.next())).not.toEqual(
      Array.from({ length: 20 }, () => b.next()),
    );
  });

  it('emits uniform values strictly within [0,1)', () => {
    const rng = createRandom(99);
    for (let i = 0; i < 10_000; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('has an approximately uniform distribution', () => {
    const rng = createRandom(7);
    const buckets = new Array<number>(10).fill(0);
    const samples = 100_000;
    for (let i = 0; i < samples; i += 1) {
      buckets[Math.floor(rng.next() * 10)]! += 1;
    }
    for (const count of buckets) {
      // Each decile should hold ~10 % of samples; allow a generous ±1.5 % band.
      expect(count / samples).toBeGreaterThan(0.085);
      expect(count / samples).toBeLessThan(0.115);
    }
  });

  it('generates normals with the requested mean and standard deviation', () => {
    const rng = createRandom(2024);
    const samples = Array.from({ length: 50_000 }, () => rng.normal(100, 15));
    expect(mean(samples)).toBeGreaterThan(99);
    expect(mean(samples)).toBeLessThan(101);
    expect(stdDev(samples)).toBeGreaterThan(14.5);
    expect(stdDev(samples)).toBeLessThan(15.5);
  });

  it('honours the requested probability in chance()', () => {
    const rng = createRandom(31);
    const hits = Array.from({ length: 50_000 }, () => rng.chance(0.25)).filter(Boolean).length;
    expect(hits / 50_000).toBeGreaterThan(0.24);
    expect(hits / 50_000).toBeLessThan(0.26);
  });

  it('produces exponential inter-arrival times with mean 1/rate', () => {
    const rng = createRandom(555);
    const samples = Array.from({ length: 50_000 }, () => rng.exponential(0.5));
    expect(mean(samples)).toBeGreaterThan(1.9);
    expect(mean(samples)).toBeLessThan(2.1);
  });

  it('throws rather than returning undefined when picking from an empty array', () => {
    const rng = createRandom(1);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('can snapshot and restore its state mid-stream', () => {
    const rng = createRandom(404);
    rng.next();
    rng.next();
    const checkpoint = rng.getState();
    const expected = Array.from({ length: 10 }, () => rng.next());

    rng.setState(checkpoint);
    expect(Array.from({ length: 10 }, () => rng.next())).toEqual(expected);
  });

  it('restores exactly when the checkpoint lands mid-way through normal draws', () => {
    // Regression guard: an implementation that caches the spare Box–Muller value keeps
    // state outside `getState()`, so this restore silently diverges.
    const rng = createRandom(808);
    rng.normal(0, 1);
    const checkpoint = rng.getState();
    const expected = [rng.normal(0, 1), rng.normal(0, 1), rng.normal(0, 1)];

    rng.setState(checkpoint);
    expect([rng.normal(0, 1), rng.normal(0, 1), rng.normal(0, 1)]).toEqual(expected);
  });

  it('consumes exactly two uniforms per normal draw', () => {
    // The invariant that makes a whole telemetry run replayable from one 32-bit number.
    const counter = createRandom(1234);
    counter.next();
    counter.next();
    const afterTwoUniforms = counter.getState();

    const normalDrawer = createRandom(1234);
    normalDrawer.normal(0, 1);
    expect(normalDrawer.getState()).toBe(afterTwoUniforms);
  });
});

describe('hashSeed', () => {
  it('is stable across calls', () => {
    expect(hashSeed('SLC-MANUFACTURING-01')).toBe(hashSeed('SLC-MANUFACTURING-01'));
  });

  it('separates similar inputs', () => {
    expect(hashSeed('slice-a')).not.toBe(hashSeed('slice-b'));
  });

  it('returns an unsigned 32-bit integer', () => {
    const value = hashSeed('anything');
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });
});
