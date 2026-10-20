export function formatKbps(kbps: number): string {
  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(2)} Mbps`;
  }
  return `${Math.round(kbps)} kbps`;
}

export function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return '--';
  return `${ms.toFixed(1)} ms`;
}

export function formatPercent(pct: number | null): string {
  if (pct === null || pct === undefined) return '--';
  return `${pct.toFixed(2)}%`;
}
