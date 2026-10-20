import { createLogger } from '@/utils/logger';

const log = createLogger('scheduler');

/**
 * Background job scheduler.
 *
 * `setInterval` is deliberately NOT used. With an interval, a task that occasionally takes
 * longer than its period gets re-entered concurrently; the overlapping runs contend, each
 * takes longer, and the process spirals. For a loop that reads the network and mutates slice
 * allocations, overlapping runs would mean two arbitration passes acting on the same
 * contention event and double-degrading a slice.
 *
 * Instead each job self-schedules: run → await → schedule the next run. The period becomes
 * a MINIMUM gap rather than a fixed cadence, so a slow tick delays the next one instead of
 * stacking on top of it.
 *
 * Other properties that matter operationally:
 *  - a throwing job is logged and rescheduled; one bad tick never kills the loop,
 *  - timers are `unref`'d so they cannot hold the process open during shutdown,
 *  - `stop()` awaits any in-flight run, so shutdown never interrupts a half-applied
 *    allocation,
 *  - per-job statistics are exposed for the Settings → System screen.
 */
export interface JobDefinition {
  name: string;
  intervalMs: number;
  run: () => Promise<void> | void;
  /** Delay before the first run. Staggering avoids a thundering herd at boot. */
  initialDelayMs?: number;
  /** Skip a scheduled run when this returns false. */
  enabled?: () => boolean;
}

export interface JobStats {
  name: string;
  intervalMs: number;
  runs: number;
  failures: number;
  skipped: number;
  lastRunAtMs: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  running: boolean;
  /** Runs whose duration exceeded the configured interval. */
  overruns: number;
}

interface ScheduledJob {
  definition: JobDefinition;
  timer: NodeJS.Timeout | null;
  stats: JobStats;
  inFlight: Promise<void> | null;
  stopped: boolean;
}

export class JobScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private started = false;

  register(definition: JobDefinition): void {
    if (this.jobs.has(definition.name)) {
      throw new Error(`Job '${definition.name}' is already registered`);
    }

    this.jobs.set(definition.name, {
      definition,
      timer: null,
      inFlight: null,
      stopped: false,
      stats: {
        name: definition.name,
        intervalMs: definition.intervalMs,
        runs: 0,
        failures: 0,
        skipped: 0,
        lastRunAtMs: null,
        lastDurationMs: null,
        lastError: null,
        running: false,
        overruns: 0,
      },
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    for (const job of this.jobs.values()) {
      job.stopped = false;
      this.schedule(job, job.definition.initialDelayMs ?? 0);
    }

    log.info({ jobs: [...this.jobs.keys()] }, 'background jobs started');
  }

  /** Stop scheduling and wait for any in-flight run to finish. */
  async stop(): Promise<void> {
    this.started = false;

    for (const job of this.jobs.values()) {
      job.stopped = true;
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
    }

    // Draining matters: interrupting an allocation mid-apply would leave slices degraded
    // with no corresponding audit record.
    await Promise.allSettled([...this.jobs.values()].map((job) => job.inFlight ?? Promise.resolve()));
    log.info('background jobs stopped');
  }

  /** Run a job immediately, outside its schedule. Used by tests and manual triggers. */
  async runNow(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown job '${name}'`);
    await this.execute(job);
  }

  stats(): JobStats[] {
    return [...this.jobs.values()].map((job) => ({ ...job.stats }));
  }

  private schedule(job: ScheduledJob, delayMs: number): void {
    if (job.stopped || !this.started) return;

    job.timer = setTimeout(() => {
      void this.execute(job).finally(() => {
        // Self-scheduling: the next run is queued only after this one completes, so a slow
        // tick can never overlap with the next.
        this.schedule(job, job.definition.intervalMs);
      });
    }, delayMs);

    // Never hold the event loop open purely to run a background job.
    job.timer.unref();
  }

  private async execute(job: ScheduledJob): Promise<void> {
    if (job.definition.enabled && !job.definition.enabled()) {
      job.stats.skipped += 1;
      return;
    }

    // Belt and braces: `runNow` can be invoked while a scheduled run is in flight.
    if (job.inFlight) {
      job.stats.skipped += 1;
      return;
    }

    const startedAt = Date.now();
    job.stats.running = true;

    job.inFlight = (async () => {
      try {
        await job.definition.run();
        job.stats.lastError = null;
      } catch (error) {
        job.stats.failures += 1;
        job.stats.lastError = error instanceof Error ? error.message : String(error);
        log.error({ job: job.definition.name, err: error }, 'job failed; will run again next tick');
      } finally {
        const duration = Date.now() - startedAt;
        job.stats.runs += 1;
        job.stats.lastRunAtMs = startedAt;
        job.stats.lastDurationMs = duration;
        job.stats.running = false;

        if (duration > job.definition.intervalMs) {
          job.stats.overruns += 1;
          log.warn(
            { job: job.definition.name, durationMs: duration, intervalMs: job.definition.intervalMs },
            'job overran its interval; the effective cadence is slower than configured',
          );
        }
      }
    })();

    try {
      await job.inFlight;
    } finally {
      job.inFlight = null;
    }
  }
}
