import { HealthRegistry } from '@/config/health';
import { SystemClock, type IClock } from '@/interfaces/clock.port';
import { createLogger } from '@/utils/logger';

const log = createLogger('container');

/**
 * COMPOSITION ROOT
 * ================
 * The single place where interfaces are bound to concrete adapters. Nothing else in the
 * codebase may call `new FirestoreRepository(...)` or read `env.DATASTORE_DRIVER` to
 * decide behaviour — everything receives its collaborators through constructor injection.
 *
 * Deliberately hand-written rather than using a DI framework:
 *  - the wiring is readable top-to-bottom by a new engineer,
 *  - there is no decorator/metadata build step,
 *  - tests construct a container with fakes in three lines and no container library.
 *
 * Disposal order matters. Registered disposers run in REVERSE registration order (last
 * constructed is torn down first), which mirrors the dependency direction: a job that uses
 * a repository is stopped before the repository is flushed and closed.
 */

export interface Disposer {
  name: string;
  dispose: () => Promise<void> | void;
}

export interface BaseContainer {
  readonly clock: IClock;
  readonly health: HealthRegistry;
  readonly startedAt: number;
  registerDisposer(name: string, dispose: Disposer['dispose']): void;
  shutdown(): Promise<void>;
}

export interface ContainerOverrides {
  clock?: IClock;
}

export function createBaseContainer(overrides: ContainerOverrides = {}): BaseContainer {
  const disposers: Disposer[] = [];
  let shuttingDown = false;

  return {
    clock: overrides.clock ?? new SystemClock(),
    health: new HealthRegistry(),
    startedAt: Date.now(),

    registerDisposer(name, dispose) {
      disposers.push({ name, dispose });
    },

    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;

      for (const { name, dispose } of [...disposers].reverse()) {
        try {
          await dispose();
          log.debug({ resource: name }, 'disposed');
        } catch (error) {
          // A failing disposer must never prevent the remaining ones from running,
          // otherwise one stuck socket leaks the entire datastore write buffer.
          log.error({ resource: name, err: error }, 'disposer failed; continuing shutdown');
        }
      }
      log.info({ count: disposers.length }, 'shutdown complete');
    },
  };
}
