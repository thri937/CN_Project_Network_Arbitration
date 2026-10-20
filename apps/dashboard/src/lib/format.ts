import type {
  CapacityLevel,
  ComplianceLevel,
  ContentionSeverity,
  DepartmentCriticality,
  HealthState,
  RecoveryTolerance,
  SliceDisposition,
  SliceStatus,
} from '@/types/api';

/**
 * Formatting.
 *
 * All display formatting lives here, for one reason: the same figure must read identically
 * wherever it appears. A bandwidth shown as "1.2 Gbps" on a slice card and "1200 Mbps" in
 * the decision detail makes an operator do mental arithmetic during an incident, and
 * mental arithmetic during an incident produces mistakes.
 */

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Bandwidth. The testbed's unit is kbps (the API fields keep their `…Mbps` names because the
 * engine does not care about units: 1 unit = 1 kbps). Always kbps, so 950 and 1,480 are
 * never shown in two different units side by side.
 */
export function formatBandwidth(kbps: number | null | undefined, _precision?: number): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return '—';
  return `${Math.round(kbps).toLocaleString('en-GB')} kbps`;
}

/** Bandwidth without the unit, for a table column with "kbps" in its header. */
export function formatBandwidthValue(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return '—';
  return Math.round(kbps).toLocaleString('en-GB');
}

export function formatPercent(value: number | null | undefined, precision = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(precision)}%`;
}

/** A 0–1 ratio rendered as a percentage. */
export function formatRatio(ratio: number | null | undefined, precision = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(precision)}%`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return `${Math.round(ms).toLocaleString('en-GB')} ms`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en', { notation: value >= 10_000 ? 'compact' : 'standard' }).format(
    value,
  );
}

export function formatCurrency(value: number, symbol = '£'): string {
  if (!Number.isFinite(value)) return '—';
  const formatted = new Intl.NumberFormat('en', {
    notation: value >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
  return `${symbol}${formatted}`;
}

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Relative time. Past is "3m ago", future is "in 3m" — used for degradation expiry. */
export function formatRelative(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return '—';

  const ms = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(ms)) return '—';

  const deltaSeconds = (ms - Date.now()) / 1000;
  const magnitude = Math.abs(deltaSeconds);

  if (magnitude < 5) return 'just now';

  const rendered = formatDuration(magnitude);
  return deltaSeconds < 0 ? `${rendered} ago` : `in ${rendered}`;
}

export function formatTime(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return '—';
  const ms = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDateTime(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return '—';
  const ms = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/* ------------------------------------------------------------------ */
/* Enumerations → prose                                                */
/* ------------------------------------------------------------------ */

/** `MISSION_CRITICAL` → `Mission Critical`. */
export function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/* ------------------------------------------------------------------ */
/* Semantic colour mapping                                             */
/* ------------------------------------------------------------------ */

/**
 * Status → Tailwind classes.
 *
 * Centralised so a HEALTHY slice looks the same on the dashboard, the topology view and
 * the slice table. Every mapping returns text AND background AND border, because a badge
 * that changes only its text colour is invisible at a glance from across a room.
 */
export interface StatusStyle {
  text: string;
  bg: string;
  border: string;
  /** Raw colour for chart strokes and inline SVG, where classes cannot be used. */
  chart: string;
}

const STYLES = {
  healthy: {
    text: 'text-healthy',
    bg: 'bg-healthy/10',
    border: 'border-healthy/30',
    chart: 'rgb(var(--healthy))',
  },
  warning: {
    text: 'text-warning',
    bg: 'bg-warning/10',
    border: 'border-warning/30',
    chart: 'rgb(var(--warning))',
  },
  degraded: {
    text: 'text-degraded',
    bg: 'bg-degraded/10',
    border: 'border-degraded/30',
    chart: 'rgb(var(--degraded))',
  },
  critical: {
    text: 'text-critical',
    bg: 'bg-critical/10',
    border: 'border-critical/30',
    chart: 'rgb(var(--critical))',
  },
  info: {
    text: 'text-info',
    bg: 'bg-info/10',
    border: 'border-info/30',
    chart: 'rgb(var(--info))',
  },
  neutral: {
    text: 'text-content-muted',
    bg: 'bg-surface-sunken',
    border: 'border-edge',
    chart: 'rgb(var(--content-subtle))',
  },
} satisfies Record<string, StatusStyle>;

export function healthStyle(health: HealthState): StatusStyle {
  switch (health) {
    case 'HEALTHY':
      return STYLES.healthy;
    case 'WARNING':
      return STYLES.warning;
    case 'DEGRADED':
      return STYLES.degraded;
    case 'CRITICAL':
      return STYLES.critical;
    default:
      return STYLES.neutral;
  }
}

export function sliceStatusStyle(status: SliceStatus): StatusStyle {
  switch (status) {
    case 'ACTIVE':
      return STYLES.healthy;
    case 'DEGRADED':
      return STYLES.critical;
    case 'RECOVERING':
      return STYLES.warning;
    case 'PAUSED':
      return STYLES.neutral;
    case 'PROVISIONING':
      return STYLES.info;
    default:
      return STYLES.neutral;
  }
}

export function capacityLevelStyle(level: CapacityLevel): StatusStyle {
  switch (level) {
    case 'HEALTHY':
      return STYLES.healthy;
    case 'ELEVATED':
      return STYLES.info;
    case 'WARNING':
      return STYLES.warning;
    case 'CRITICAL':
      return STYLES.degraded;
    case 'OVERSUBSCRIBED':
      return STYLES.critical;
    default:
      return STYLES.neutral;
  }
}

export function severityStyle(severity: ContentionSeverity): StatusStyle {
  switch (severity) {
    case 'MINOR':
      return STYLES.info;
    case 'MODERATE':
      return STYLES.warning;
    case 'SEVERE':
      return STYLES.degraded;
    case 'CRITICAL':
      return STYLES.critical;
    default:
      return STYLES.neutral;
  }
}

export function criticalityStyle(criticality: DepartmentCriticality): StatusStyle {
  switch (criticality) {
    case 'MISSION_CRITICAL':
      return STYLES.critical;
    case 'BUSINESS_CRITICAL':
      return STYLES.degraded;
    case 'BUSINESS_OPERATIONAL':
      return STYLES.warning;
    case 'ADMINISTRATIVE':
      return STYLES.info;
    default:
      return STYLES.neutral;
  }
}

export function complianceStyle(level: ComplianceLevel): StatusStyle {
  switch (level) {
    case 'LIFE_SAFETY':
      return STYLES.critical;
    case 'REGULATED':
      return STYLES.degraded;
    case 'CONTRACTUAL':
      return STYLES.warning;
    case 'INTERNAL':
      return STYLES.info;
    default:
      return STYLES.neutral;
  }
}

/**
 * Disposition → style.
 *
 * EXEMPT is styled as `info` rather than as a warning: it is the platform working exactly
 * as intended, protecting a life-safety slice. Colouring it red would train operators to
 * read a correct outcome as a problem.
 */
export function dispositionStyle(disposition: SliceDisposition): StatusStyle {
  switch (disposition) {
    case 'PROTECTED':
      return STYLES.healthy;
    case 'DEGRADED':
      return STYLES.critical;
    case 'EXEMPT':
      return STYLES.info;
    default:
      return STYLES.neutral;
  }
}

export function recoveryToleranceStyle(tolerance: RecoveryTolerance): StatusStyle {
  switch (tolerance) {
    case 'ZERO':
      return STYLES.critical;
    case 'LOW':
      return STYLES.degraded;
    case 'MODERATE':
      return STYLES.warning;
    default:
      return STYLES.healthy;
  }
}

/** Business priority score (0–100) → style, for score chips. */
export function scoreStyle(score: number): StatusStyle {
  if (score >= 80) return STYLES.critical;
  if (score >= 60) return STYLES.degraded;
  if (score >= 40) return STYLES.warning;
  if (score >= 20) return STYLES.info;
  return STYLES.neutral;
}

export { STYLES as statusStyles };
