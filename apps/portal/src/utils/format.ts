/** Bandwidth in kbps, the testbed's unit. Unknown shows as a dash. */
export function formatKbps(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return '—';
  return `${Math.round(kbps).toLocaleString('en-GB')} kbps`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return `${Math.round(ms).toLocaleString('en-GB')} ms`;
}

export function formatPercent(pct: number | null | undefined, digits = 1): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(digits)} %`;
}

const PROFILES: Record<string, string> = { URLLC: 'URLLC', EMBB: 'eMBB', MMTC: 'mMTC', V2X: 'V2X' };

/** QoS label as people write it (the engine stores EMBB, MMTC). */
export function profileLabel(profile: string): string {
  return PROFILES[profile.toUpperCase()] ?? profile;
}
