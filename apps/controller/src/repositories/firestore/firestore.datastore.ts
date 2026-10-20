import type { Firestore } from 'firebase-admin/firestore';
import type { CollectionName } from '@/constants/collections';
import { Collections } from '@/constants/collections';
import type { IDatastore, IRepository, TransactionContext } from '@/interfaces/repository.port';
import type { AuditableEntity } from '@/types/common';
import { getFirestoreClient } from '@/firebase/admin';
import { DatastoreError, InternalError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';
import { FirestoreRepository } from './firestore.repository';

const log = createLogger('firestore-datastore');

export const FIRESTORE_DRIVER = 'firestore';

/**
 * Firestore datastore adapter — the production persistence driver.
 *
 * Firestore transactions are optimistic and are retried automatically by the SDK on write
 * contention, which is why `runTransaction` callbacks must be free of side effects. That
 * requirement is stated on the port, and the in-memory driver enforces the same discipline
 * by re-running its callback on a snapshot conflict.
 */
export class FirestoreDatastore implements IDatastore {
  readonly driver = FIRESTORE_DRIVER;

  private readonly repositories = new Map<CollectionName, IRepository<never>>();
  private readonly firestore: Firestore;

  constructor(firestore?: Firestore) {
    this.firestore = firestore ?? getFirestoreClient();
  }

  repository<T extends AuditableEntity>(collection: CollectionName): IRepository<T> {
    let existing = this.repositories.get(collection);
    if (!existing) {
      existing = new FirestoreRepository<T>(
        collection,
        this.firestore,
        this,
      ) as unknown as IRepository<never>;
      this.repositories.set(collection, existing);
    }
    return existing as unknown as IRepository<T>;
  }

  async runTransaction<R>(
    fn: (tx: TransactionContext) => Promise<R>,
    label = 'transaction',
  ): Promise<R> {
    try {
      return await this.firestore.runTransaction(async (nativeTx) =>
        fn({ driver: this.driver, native: nativeTx }),
      );
    } catch (error) {
      log.error({ label, err: error }, 'transaction failed');
      throw error;
    }
  }

  /** @internal Unwraps and validates a transaction handle produced by THIS driver. */
  unwrap(tx: TransactionContext | undefined): FirebaseFirestore.Transaction | undefined {
    if (!tx) return undefined;
    if (tx.driver !== this.driver) {
      throw new InternalError(
        `Transaction from driver '${tx.driver}' cannot be used with the '${this.driver}' datastore`,
      );
    }
    return tx.native as FirebaseFirestore.Transaction;
  }

  async ping(): Promise<void> {
    try {
      // A bounded read against a small collection. `limit(1)` keeps the probe to a single
      // document read, so a 2-second health poll costs ~43k reads/day — negligible — while
      // still exercising credentials, network and IAM permissions end to end.
      await this.firestore.collection(Collections.SETTINGS).limit(1).get();
    } catch (error) {
      throw new DatastoreError('firestore ping', error);
    }
  }

  async dispose(): Promise<void> {
    try {
      // Terminates gRPC channels and rejects pending operations. Without this the process
      // can hang for the full keep-alive interval on shutdown.
      await this.firestore.terminate();
      log.info('firestore client terminated');
    } catch (error) {
      log.warn({ err: error }, 'error terminating firestore client');
    }
  }
}
