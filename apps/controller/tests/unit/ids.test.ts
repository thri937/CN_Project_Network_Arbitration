import { describe, expect, it } from 'vitest';
import { IdPrefix, generateCorrelationId, generateId, isGeneratedId, timestampFromId } from '@/utils/ids';

describe('identifier generation', () => {
  it('produces prefixed, human-legible identifiers', () => {
    const id = generateId(IdPrefix.ARBITRATION);
    expect(id.startsWith('ARB-')).toBe(true);
    expect(isGeneratedId(id)).toBe(true);
  });

  it('avoids ambiguous characters in the random component', () => {
    // Crockford base32 omits I, L, O and U so operators can read ids aloud during an
    // incident call without transcription errors.
    for (let i = 0; i < 500; i += 1) {
      const random = generateId(IdPrefix.SLICE).split('-')[2]!;
      expect(random).not.toMatch(/[ILOU]/);
    }
  });

  it('is collision-free across a large batch', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => generateId(IdPrefix.TELEMETRY)));
    expect(ids.size).toBe(20_000);
  });

  it('sorts lexicographically in creation order', () => {
    const early = generateId(IdPrefix.AUDIT, Date.UTC(2026, 0, 1));
    const later = generateId(IdPrefix.AUDIT, Date.UTC(2026, 6, 1));
    expect(early < later).toBe(true);
  });

  it('round-trips the embedded creation timestamp', () => {
    const at = Date.UTC(2026, 2, 15, 9, 30, 0);
    expect(timestampFromId(generateId(IdPrefix.CONTENTION, at))).toBe(at);
  });

  it('returns null when a timestamp cannot be recovered', () => {
    expect(timestampFromId('not-an-id')).toBe(null);
    expect(timestampFromId('AB')).toBe(null);
  });

  it('rejects foreign identifiers', () => {
    expect(isGeneratedId('some-random-string')).toBe(false);
    expect(isGeneratedId('slc-123-abcdef')).toBe(false);
  });

  it('generates unique correlation ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, generateCorrelationId));
    expect(ids.size).toBe(1000);
  });
});
