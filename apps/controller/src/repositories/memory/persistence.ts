import fs from 'node:fs/promises';
import path from 'node:path';
import type { CollectionName } from '@/constants/collections';
import { createLogger } from '@/utils/logger';

const log = createLogger('memory-persistence');

/**
 * Disk persistence for the in-memory datastore.
 *
 * This is what makes the `memory` driver a genuine adapter rather than a toy: departments,
 * slices, policies and audit logs survive a restart, so a developer can build a scenario
 * over an afternoon without a cloud project. Firestore remains the production driver.
 *
 * Durability model — deliberately chosen, with its limits stated:
 *
 *  - Writes are DEBOUNCED. A telemetry tick every 2 s across 12 slices would otherwise
 *    produce a continuous stream of full-collection rewrites and dominate the process's
 *    CPU time. Losing the last `flushMs` of telemetry on a hard kill is acceptable;
 *    telemetry is a sampled signal, not a ledger.
 *
 *  - Each flush is ATOMIC per collection: serialise to `<name>.json.tmp`, fsync, then
 *    rename over the target. `rename` is atomic on both NTFS and POSIX, so a crash
 *    mid-write leaves the previous good snapshot intact rather than a truncated file.
 *
 *  - `flushNow()` is awaited during graceful shutdown, so an orderly stop loses nothing.
 */
export interface PersistenceOptions {
  directory: string;
  enabled: boolean;
  flushMs: number;
}

export class SnapshotPersistence {
  private readonly dirty = new Set<CollectionName>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly options: PersistenceOptions,
    private readonly readCollection: (name: CollectionName) => Record<string, unknown>,
  ) {}

  /** Load every previously persisted collection. Missing files are simply empty. */
  async load(names: readonly CollectionName[]): Promise<Map<CollectionName, Record<string, unknown>>> {
    const result = new Map<CollectionName, Record<string, unknown>>();
    if (!this.options.enabled) return result;

    await fs.mkdir(this.options.directory, { recursive: true });

    await Promise.all(
      names.map(async (name) => {
        const file = this.fileFor(name);
        try {
          const raw = await fs.readFile(file, 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            result.set(name, parsed as Record<string, unknown>);
          } else {
            log.warn({ collection: name, file }, 'snapshot is not an object; ignoring');
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return; // First run — nothing persisted yet.
          // A corrupt snapshot must not prevent startup. Quarantine it and continue with
          // an empty collection; the operator can inspect the .corrupt file afterwards.
          log.error({ collection: name, file, err: error }, 'snapshot unreadable; quarantining');
          await fs
            .rename(file, `${file}.corrupt-${Date.now()}`)
            .catch((renameError: unknown) =>
              log.error({ file, err: renameError }, 'failed to quarantine corrupt snapshot'),
            );
        }
      }),
    );

    log.info(
      { directory: this.options.directory, collections: result.size },
      'loaded persisted snapshots',
    );
    return result;
  }

  /** Mark a collection as needing persistence and (re)arm the debounce timer. */
  markDirty(name: CollectionName): void {
    if (!this.options.enabled || this.disposed) return;
    this.dirty.add(name);
    if (this.timer) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.options.flushMs);
    // Never hold the event loop open purely to flush a snapshot.
    this.timer.unref();
  }

  /** Persist all dirty collections immediately. Safe to call concurrently. */
  async flushNow(): Promise<void> {
    if (!this.options.enabled) return;
    // Serialise flushes: two concurrent writers racing on the same .tmp file would
    // interleave and could rename a partially written snapshot into place.
    if (this.inFlight) {
      await this.inFlight;
      if (this.dirty.size === 0) return;
    }

    const pending = [...this.dirty];
    this.dirty.clear();
    if (pending.length === 0) return;

    this.inFlight = (async () => {
      await fs.mkdir(this.options.directory, { recursive: true });
      for (const name of pending) {
        try {
          await this.writeAtomically(name, this.readCollection(name));
        } catch (error) {
          // Re-arm so the data is not lost; a transient EBUSY on Windows is common.
          this.dirty.add(name);
          log.error({ collection: name, err: error }, 'snapshot flush failed; will retry');
        }
      }
    })();

    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flushNow();
    this.disposed = true;
  }

  private fileFor(name: CollectionName): string {
    return path.join(this.options.directory, `${name}.json`);
  }

  private async writeAtomically(name: CollectionName, data: Record<string, unknown>): Promise<void> {
    const target = this.fileFor(name);
    const temp = `${target}.tmp`;
    const payload = JSON.stringify(data);

    const handle = await fs.open(temp, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      // fsync before rename: without it, a power loss can leave the renamed file present
      // but empty, which is strictly worse than the stale snapshot it replaced.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
  }
}
