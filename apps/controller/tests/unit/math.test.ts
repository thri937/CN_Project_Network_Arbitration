import { describe, expect, it } from 'vitest';
import {
  approxEqual,
  clamp,
  clamp01,
  ewma,
  linearTrend,
  logNormalise,
  mapRange,
  mean,
  median,
  normaliseWeights,
  percentile,
  round,
  safeDivide,
  stdDev,
  sum,
} from '@/utils/math';

describe('math primitives', () => {
  describe('clamp', () => {
    it('constrains to the range', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(11, 0, 10)).toBe(10);
    });

    it('returns the lower bound for NaN rather than propagating it', () => {
      // A NaN leaking into the harm function would silently poison an entire
      // arbitration run, so clamp is the designated NaN firewall.
      expect(clamp(Number.NaN, 2, 8)).toBe(2);
      expect(clamp01(Number.NaN)).toBe(0);
    });
  });

  describe('safeDivide', () => {
    it('divides normally', () => {
      expect(safeDivide(10, 4)).toBe(2.5);
    });

    it('returns the fallback instead of Infinity or NaN', () => {
      expect(safeDivide(1, 0)).toBe(0);
      expect(safeDivide(1, 0, -1)).toBe(-1);
      expect(safeDivide(0, 0)).toBe(0);
      expect(safeDivide(Number.NaN, 2, 42)).toBe(42);
      expect(safeDivide(1, Number.POSITIVE_INFINITY, 7)).toBe(7);
    });
  });

  describe('mapRange', () => {
    it('maps and clamps at both ends', () => {
      expect(mapRange(5, 0, 10, 0, 100)).toBe(50);
      expect(mapRange(-5, 0, 10, 0, 100)).toBe(0);
      expect(mapRange(15, 0, 10, 0, 100)).toBe(100);
    });

    it('does not divide by zero on a degenerate input range', () => {
      expect(mapRange(5, 3, 3, 10, 20)).toBe(10);
    });
  });

  describe('round', () => {
    it('avoids binary floating point artefacts', () => {
      expect(round(1.005, 2)).toBe(1.01);
      expect(round(2.675, 2)).toBe(2.68);
      expect(round(-1.005, 2)).toBe(-1.01);
    });

    it('returns 0 for non-finite input', () => {
      expect(round(Number.POSITIVE_INFINITY)).toBe(0);
      expect(round(Number.NaN)).toBe(0);
    });
  });

  describe('descriptive statistics', () => {
    const sample = [4, 8, 15, 16, 23, 42];

    it('computes sum, mean and median', () => {
      expect(sum(sample)).toBe(108);
      expect(mean(sample)).toBe(18);
      expect(median(sample)).toBe(15.5);
      expect(median([3, 1, 2])).toBe(2);
    });

    it('handles empty input without throwing', () => {
      expect(sum([])).toBe(0);
      expect(mean([])).toBe(0);
      expect(median([])).toBe(0);
      expect(stdDev([])).toBe(0);
      expect(percentile([], 95)).toBe(0);
    });

    it('computes the sample standard deviation', () => {
      expect(round(stdDev([2, 4, 4, 4, 5, 5, 7, 9]), 4)).toBe(2.1381);
      expect(stdDev([5])).toBe(0);
    });

    it('computes nearest-rank percentiles', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      expect(percentile(values, 50)).toBe(5);
      expect(percentile(values, 95)).toBe(10);
      expect(percentile(values, 0)).toBe(1);
      expect(percentile(values, 100)).toBe(10);
    });
  });

  describe('ewma', () => {
    it('seeds from the first sample', () => {
      expect(ewma(null, 42, 0.3)).toBe(42);
    });

    it('blends toward the new sample', () => {
      expect(ewma(10, 20, 0.5)).toBe(15);
      expect(ewma(10, 20, 1)).toBe(20);
      expect(ewma(10, 20, 0)).toBe(10);
    });
  });

  describe('linearTrend', () => {
    it('reports a positive slope for rising utilisation', () => {
      expect(linearTrend([1, 2, 3, 4, 5])).toBeCloseTo(1, 10);
    });

    it('reports a negative slope for falling utilisation', () => {
      expect(linearTrend([5, 4, 3, 2, 1])).toBeCloseTo(-1, 10);
    });

    it('reports zero for a flat or degenerate series', () => {
      expect(linearTrend([7, 7, 7])).toBe(0);
      expect(linearTrend([7])).toBe(0);
      expect(linearTrend([])).toBe(0);
    });
  });

  describe('logNormalise', () => {
    it('maps the reference value to 50', () => {
      expect(round(logNormalise(1000, 1000), 6)).toBe(50);
    });

    it('is monotonically increasing but never saturates', () => {
      const oneDecade = logNormalise(10_000, 1000);
      const twoDecades = logNormalise(100_000, 1000);
      const extreme = logNormalise(10_000_000_000, 1000);

      expect(oneDecade).toBeGreaterThan(50);
      expect(twoDecades).toBeGreaterThan(oneDecade);
      expect(extreme).toBeGreaterThan(twoDecades);
      expect(extreme).toBeLessThan(100);
    });

    it('compresses outliers — this is why downtime cost cannot dominate the score', () => {
      // A department claiming 10,000x the reference cost must not score 10,000x higher.
      const normal = logNormalise(1000, 1000);
      const outlier = logNormalise(10_000_000, 1000);
      expect(outlier / normal).toBeLessThan(2);
    });

    it('returns 0 for non-positive input', () => {
      expect(logNormalise(0, 1000)).toBe(0);
      expect(logNormalise(-5, 1000)).toBe(0);
    });
  });

  describe('normaliseWeights', () => {
    it('rescales to sum to 1 while preserving ratios', () => {
      const result = normaliseWeights({ a: 2, b: 3, c: 5 });
      expect(sum(Object.values(result))).toBeCloseTo(1, 12);
      expect(result.a).toBeCloseTo(0.2, 12);
      expect(result.c / result.b).toBeCloseTo(5 / 3, 12);
    });

    it('falls back to a uniform distribution when weights sum to zero', () => {
      const result = normaliseWeights({ a: 0, b: 0 });
      expect(result.a).toBe(0.5);
      expect(result.b).toBe(0.5);
    });

    it('handles an empty record', () => {
      expect(normaliseWeights({})).toEqual({});
    });
  });

  describe('approxEqual', () => {
    it('tolerates float representation error', () => {
      expect(approxEqual(0.1 + 0.2, 0.3)).toBe(true);
      expect(0.1 + 0.2 === 0.3).toBe(false);
      expect(approxEqual(1, 1.1)).toBe(false);
    });
  });
});
