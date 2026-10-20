import { cert, getApp, getApps, initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { env } from '@/config/env';
import { createLogger } from '@/utils/logger';
import { InternalError } from '@/utils/errors';

const log = createLogger('firebase');

const APP_NAME = 'arbitration-platform';

/**
 * Firebase Admin SDK bootstrap.
 *
 * The ONLY module in the codebase permitted to import `firebase-admin`. Everything else
 * depends on `IDatastore` / `IAuthPort`. Concentrating the dependency here is what makes
 * "swap Firestore for PostgreSQL" a two-file change rather than a rewrite.
 *
 * Credential resolution order, most explicit first:
 *   1. `FIRESTORE_EMULATOR_HOST`      → emulator, no credentials needed
 *   2. inline service-account triple  → `cert()`  (Render/Railway env vars)
 *   3. `GOOGLE_APPLICATION_CREDENTIALS` → `applicationDefault()` (GCP, local key file)
 *
 * Initialisation is idempotent and lazy: importing this module has no side effects, so a
 * deployment running `DATASTORE_DRIVER=memory` never touches Firebase at all.
 */

let cachedApp: App | null = null;
let cachedFirestore: Firestore | null = null;

export function getFirebaseApp(): App {
  if (cachedApp) return cachedApp;

  const existing = getApps().find((app) => app.name === APP_NAME);
  if (existing) {
    cachedApp = existing;
    return existing;
  }

  cachedApp = initializeApp(buildAppOptions(), APP_NAME);
  return cachedApp;
}

function buildAppOptions(): Parameters<typeof initializeApp>[0] {
  if (env.FIRESTORE_EMULATOR_HOST) {
    log.warn(
      { host: env.FIRESTORE_EMULATOR_HOST },
      'connecting to the Firestore EMULATOR — no production data will be touched',
    );
    return { projectId: env.FIREBASE_PROJECT_ID ?? 'demo-arbitration' };
  }

  if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    log.info({ projectId: env.FIREBASE_PROJECT_ID }, 'using inline service-account credentials');
    return {
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY,
      }),
      projectId: env.FIREBASE_PROJECT_ID,
    };
  }

  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    log.info('using application default credentials');
    return {
      credential: applicationDefault(),
      ...(env.FIREBASE_PROJECT_ID ? { projectId: env.FIREBASE_PROJECT_ID } : {}),
    };
  }

  // `config/env.ts` rejects this combination at boot, so reaching here means the guard was
  // bypassed (e.g. a direct import in a script). Fail loudly rather than half-initialised.
  throw new InternalError(
    'Firebase credentials are not configured. Set FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + ' +
      'FIREBASE_PRIVATE_KEY, or GOOGLE_APPLICATION_CREDENTIALS, or FIRESTORE_EMULATOR_HOST.',
  );
}

export function getFirestoreClient(): Firestore {
  if (cachedFirestore) return cachedFirestore;

  const firestore = getFirestore(getFirebaseApp());

  // `ignoreUndefinedProperties` is essential: TypeScript optional properties serialise to
  // `undefined`, which Firestore rejects outright. Without this, every entity with an
  // unset optional field throws at write time.
  firestore.settings({ ignoreUndefinedProperties: true });

  cachedFirestore = firestore;
  return firestore;
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}

/** Test/teardown hook — clears the module-level cache so a new config can be applied. */
export function resetFirebaseCache(): void {
  cachedApp = null;
  cachedFirestore = null;
}

export { getApp };
