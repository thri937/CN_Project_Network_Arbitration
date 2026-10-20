import { createLogger } from '@/utils/logger';

const log = createLogger('health');

export type HealthStatus = 'up' | 'degraded' | 'down';

export interface ProbeResult {
  status: HealthStatus;
  /** Human-readable detail shown on the Settings → System Health screen. */
  message?: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export type Probe = () => Promise<ProbeResult> | ProbeResult;

export interface ReadinessReport {
  status: HealthStatus;
  checks: Record<string, ProbeResult>;
  checkedAt: string;
}

/**
 * Health probe registry.
 *
 * Each adapter registers its own probe as it is constructed (`datastore`, `telemetry`,
 * `auth`, `scheduler`). The readiness endpoint aggregates them, so adding a new
 * infrastructure dependency automatically appears in `/health/ready` without editing the
 * controller — the health surface cannot silently fall out of date with the wiring.
 *
 * Aggregation rule: any `down` makes the system `down`; otherwise any `degraded` makes it
 * `degraded`. A `degraded` system still serves traffic (an orchestrator must not restart
 * it), whereas `down` fails the readiness gate and pulls the instance out of rotation.
 */
export class HealthRegistry {
  private readonly probes = new Map<string, { probe: Probe; critical: boolean }>();

  register(name: string, probe: Probe, options: { critical?: boolean } = {}): void {
    if (this.probes.has(name)) {
      log.warn({ name }, 'health probe re-registered; replacing previous definition');
    }
    this.probes.set(name, { probe, critical: options.critical ?? true });
  }

  unregister(name: string): void {
    this.probes.delete(name);
  }

  names(): string[] {
    return [...this.probes.keys()];
  }

  async check(): Promise<ReadinessReport> {
    const checks: Record<string, ProbeResult> = {};
    let worst: HealthStatus = 'up';

    const entries = [...this.probes.entries()];
    const results = await Promise.all(
      entries.map(async ([name, { probe }]) => {
        const startedAt = Date.now();
        try {
          const result = await withTimeout(probe(), 3000, name);
          return [name, { ...result, latencyMs: Date.now() - startedAt }] as const;
        } catch (error) {
          return [
            name,
            {
              status: 'down' as HealthStatus,
              message: error instanceof Error ? error.message : 'probe failed',
              latencyMs: Date.now() - startedAt,
            },
          ] as const;
        }
      }),
    );

    for (const [name, result] of results) {
      checks[name] = result;
      const critical = this.probes.get(name)?.critical ?? true;
      // A non-critical dependency failing degrades the system rather than downing it.
      const effective: HealthStatus =
        result.status === 'down' && !critical ? 'degraded' : result.status;
      if (effective === 'down') worst = 'down';
      else if (effective === 'degraded' && worst === 'up') worst = 'degraded';
    }

    return { status: worst, checks, checkedAt: new Date().toISOString() };
  }
}

async function withTimeout<T>(value: Promise<T> | T, ms: number, label: string): Promise<T> {
  if (!(value instanceof Promise)) return value;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`health probe '${label}' timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
