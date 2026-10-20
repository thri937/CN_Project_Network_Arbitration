/**
 * Network address helpers.
 */

/**
 * Normalise a client address into a stable rate-limiting key.
 *
 * IPv4 addresses are used verbatim. IPv6 addresses are truncated to their /64 prefix,
 * because a single residential or datacentre host is routinely delegated an entire /64 (or
 * larger). Keying on the full 128-bit address would let one machine cycle through
 * effectively unlimited source addresses inside its own allocation and bypass the limiter
 * completely — a well-known IPv6 rate-limiting failure mode.
 *
 * Handles the IPv4-mapped form (`::ffff:203.0.113.7`) that Node reports on dual-stack
 * sockets by unwrapping it to the underlying IPv4 address.
 */
export function normaliseClientIp(ip: string | undefined): string {
  if (!ip) return 'unknown';

  const address = ip.trim().toLowerCase();

  // IPv4-mapped IPv6 → plain IPv4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1]!;

  if (!address.includes(':')) return address;

  return `${expandIpv6(address).slice(0, 4).join(':')}::/64`;
}

/** Expand an IPv6 address (including `::` compression) into 8 four-digit hextets. */
function expandIpv6(address: string): string[] {
  // Strip a zone index (`fe80::1%eth0`) — it is host-local and not part of the address.
  const bare = address.split('%')[0] ?? address;
  const [head = '', tail = ''] = bare.includes('::') ? bare.split('::', 2) : [bare, ''];

  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = bare.includes('::') && tail ? tail.split(':').filter(Boolean) : [];

  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const parts = bare.includes('::')
    ? [...headParts, ...Array<string>(missing).fill('0'), ...tailParts]
    : headParts;

  // Pad/trim defensively: a malformed address must produce a usable key, not throw.
  return Array.from({ length: 8 }, (_, i) => (parts[i] ?? '0').padStart(4, '0'));
}
