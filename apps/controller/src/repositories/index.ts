import { DatastoreDriver, env } from '@/config/env';
import type { IDatastore } from '@/interfaces/repository.port';
import { createLogger } from '@/utils/logger';
import { MemoryDatastore } from './memory/memory.datastore';
import { FirestoreDatastore } from './firestore/firestore.datastore';

const log = createLogger('datastore-factory');

/**
 * Datastore factory — one of the hexagonal swap points.
 *
 * This is the ONLY function in the codebase that inspects `DATASTORE_DRIVER`. Services and
 * domain code receive an `IDatastore` and cannot tell which implementation they hold.
 *
 * `firebase-admin` is required lazily (inside the branch) so that a deployment running the
 * memory driver never loads the SDK, never opens a gRPC channel, and never needs
 * credentials present in the environment.
 */
export interface DatastoreFactoryOptions {
  driver?: DatastoreDriver;
  /** Memory-driver overrides; ignored by Firestore. */
  memory?: { directory?: string; persist?: boolean; flushMs?: number };
}

export async function createDatastore(
  options: DatastoreFactoryOptions = {},
): Promise<IDatastore> {
  const driver = options.driver ?? env.DATASTORE_DRIVER;

  switch (driver) {
    case DatastoreDriver.FIRESTORE: {
      const datastore = new FirestoreDatastore();
      // Fail fast: a credential or IAM problem must surface at boot, not on the first
      // write half an hour later.
      await datastore.ping();
      log.info({ driver }, 'datastore ready');
      return datastore;
    }

    case DatastoreDriver.MEMORY: {
      const datastore = new MemoryDatastore(options.memory ?? {});
      await datastore.initialise();
      log.info({ driver, directory: env.MEMORY_STORE_DIR }, 'datastore ready');
      return datastore;
    }

    default:
      return assertUnreachable(driver);
  }
}

function assertUnreachable(driver: never): never {
  throw new Error(`Unsupported datastore driver '${String(driver)}'`);
}

export { MemoryDatastore } from './memory/memory.datastore';
export { FirestoreDatastore } from './firestore/firestore.datastore';
export * from './query';
