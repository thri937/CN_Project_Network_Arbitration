import { AuthDriver, env } from '@/config/env';
import type { IAuthPort } from '@/interfaces/auth.port';
import type { IClock } from '@/interfaces/clock.port';
import { createLogger } from '@/utils/logger';
import { DevAuthAdapter } from './dev.auth.adapter';
import { FirebaseAuthAdapter } from './firebase.auth.adapter';

const log = createLogger('auth-factory');

/**
 * Identity-provider factory — one of the hexagonal swap points.
 *
 * The ONLY function that inspects `AUTH_DRIVER`. `firebase-admin` is required lazily
 * inside the branch so a deployment using the dev adapter never loads the SDK.
 */
export async function createAuthProvider(options: { clock: IClock; driver?: AuthDriver } = {} as {
  clock: IClock;
}): Promise<IAuthPort> {
  const driver = options.driver ?? env.AUTH_DRIVER;

  switch (driver) {
    case AuthDriver.FIREBASE: {
      const provider = new FirebaseAuthAdapter();
      // Fail fast on a credential or IAM problem rather than at the first login attempt.
      await provider.ping();
      log.info({ driver }, 'identity provider ready');
      return provider;
    }

    case AuthDriver.DEV: {
      const provider = new DevAuthAdapter(options.clock);
      log.info({ driver }, 'identity provider ready');
      return provider;
    }

    default:
      return assertUnreachable(driver);
  }
}

function assertUnreachable(driver: never): never {
  throw new Error(`Unsupported auth driver '${String(driver)}'`);
}

/** Type guard used by the auth routes to decide whether to mount `/auth/dev-login`. */
export function isDevAuthProvider(provider: IAuthPort): provider is DevAuthAdapter {
  return provider instanceof DevAuthAdapter;
}

export { DevAuthAdapter } from './dev.auth.adapter';
export { FirebaseAuthAdapter } from './firebase.auth.adapter';
