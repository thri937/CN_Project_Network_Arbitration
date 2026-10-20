export function formatKbps(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || typeof kbps !== 'number' || isNaN(kbps)) {
    return '0 kbps';
  }
  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(2)} Mbps`;
  }
  return `${Math.round(kbps)} kbps`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || typeof ms !== 'number' || isNaN(ms)) {
    return '--';
  }
  return `${ms.toFixed(1)} ms`;
}

export function formatPercent(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || typeof pct !== 'number' || isNaN(pct)) {
    return '--';
  }
  return `${pct.toFixed(2)}%`;
}
