/**
 * PORT — Clock
 *
 * Arbitration outcomes depend on time: recovery windows expire, fairness burden decays,
 * cooldowns gate re-arbitration. Injecting the clock makes all of that deterministic in
 * tests, and makes it possible to replay a historical contention window at wall-clock
 * speed or at 1000×.
 *
 * Domain code must NEVER call `Date.now()` directly.
 */
export interface IClock {
  /** Epoch milliseconds. */
  now(): number;
  /** ISO-8601 UTC string for the current instant. */
  nowIso(): string;
}

export class SystemClock implements IClock {
  now(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

/** Manually advanced clock for unit tests and deterministic scenario replay. */
export class FixedClock implements IClock {
  private current: number;

  constructor(startEpochMs: number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.current = startEpochMs;
  }

  now(): number {
    return this.current;
  }

  nowIso(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): this {
    this.current += ms;
    return this;
  }

  set(epochMs: number): this {
    this.current = epochMs;
    return this;
  }
}
