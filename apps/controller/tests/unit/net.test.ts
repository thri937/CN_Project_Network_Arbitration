import { describe, expect, it } from 'vitest';
import { normaliseClientIp } from '@/utils/net';

describe('normaliseClientIp', () => {
  it('passes IPv4 through unchanged', () => {
    expect(normaliseClientIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('unwraps IPv4-mapped IPv6 addresses reported by dual-stack sockets', () => {
    expect(normaliseClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normaliseClientIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });

  it('truncates IPv6 to the /64 prefix', () => {
    // Every address inside one delegated /64 must collapse to a single limiter key,
    // otherwise a host can trivially bypass rate limiting by rotating its suffix.
    const a = normaliseClientIp('2001:db8:85a3:1::8a2e:370:7334');
    const b = normaliseClientIp('2001:db8:85a3:1::dead:beef:1');
    expect(a).toBe(b);
    expect(a).toBe('2001:0db8:85a3:0001::/64');
  });

  it('separates distinct /64 prefixes', () => {
    expect(normaliseClientIp('2001:db8:85a3:1::1')).not.toBe(
      normaliseClientIp('2001:db8:85a3:2::1'),
    );
  });

  it('expands compressed forms consistently', () => {
    expect(normaliseClientIp('::1')).toBe('0000:0000:0000:0000::/64');
    expect(normaliseClientIp('2001:db8::')).toBe('2001:0db8:0000:0000::/64');
  });

  it('strips zone indices', () => {
    expect(normaliseClientIp('fe80::1%eth0')).toBe(normaliseClientIp('fe80::1'));
  });

  it('returns a stable bucket for a missing address instead of throwing', () => {
    expect(normaliseClientIp(undefined)).toBe('unknown');
    expect(normaliseClientIp('')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(normaliseClientIp('2001:DB8::1')).toBe(normaliseClientIp('2001:db8::1'));
  });
});
