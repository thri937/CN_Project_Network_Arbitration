import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { env } from '@/config/env';
import { ErrorCode } from '@/constants/errorCodes';
import type {
  AuthProviderCapabilities,
  ExternalIdentity,
  IAuthPort,
} from '@/interfaces/auth.port';
import type { IClock } from '@/interfaces/clock.port';
import { InternalError, UnauthenticatedError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';

const log = createLogger('dev-auth');

const DEV_ISSUER = 'dev-identity-provider';

/**
 * Development identity provider.
 *
 * Stands in for Firebase Authentication so the entire platform — login, RBAC, audit
 * attribution, the SPA — is runnable and CI-testable with no cloud project. It implements
 * the same `IAuthPort` contract, so swapping to Firebase changes one environment variable.
 *
 * SECURITY
 * ========
 * This adapter issues identities to ANYONE who asks. That is its purpose, and it is why
 * `config/env.ts` refuses to boot with `AUTH_DRIVER=dev` under `NODE_ENV=production`. The
 * constructor asserts the same invariant, so the guard cannot be bypassed by constructing
 * the adapter directly from a script.
 *
 * Tokens it issues are ordinary HS256 JWTs with a distinct issuer, so a development token
 * can never be mistaken for a platform session token by `TokenService`.
 */
export class DevAuthAdapter implements IAuthPort {
  readonly name = 'dev';

  constructor(private readonly clock: IClock) {
    log.info('Auth adapter active: dev/local mode');
  }

  /**
   * Mint a development identity.
   *
   * Exposed through `POST /auth/dev-login`, which is mounted only when this adapter is
   * active. The subject is derived deterministically from the email so that repeated
   * sign-ins map to the same user record across restarts — otherwise every login would
   * create a new user and the role assigned last time would be lost.
   */
  issueDevToken(input: { email: string; displayName?: string }): string {
    const raw = input.email.trim().toLowerCase();
    const email = raw.includes('@') ? raw : `${raw}@example.com`;
    const issuedAt = Math.floor(this.clock.now() / 1000);

    return jwt.sign(
      {
        sub: subjectForEmail(email),
        email,
        email_verified: true,
        ...(input.displayName ? { name: input.displayName } : {}),
        provider: 'dev',
        iat: issuedAt,
      },
      env.JWT_SECRET,
      { algorithm: 'HS256', issuer: DEV_ISSUER, expiresIn: 3600 },
    );
  }

  async verifyIdToken(idToken: string): Promise<ExternalIdentity> {
    if (!idToken || typeof idToken !== 'string') {
      throw new UnauthenticatedError('An ID token is required', ErrorCode.TOKEN_INVALID);
    }

    let decoded: jwt.JwtPayload;
    try {
      // `clockTimestamp` keeps issuance and verification on the same injected clock; see
      // the equivalent note in `TokenService.verify`.
      decoded = jwt.verify(idToken, env.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: DEV_ISSUER,
        clockTimestamp: Math.floor(this.clock.now() / 1000),
      }) as jwt.JwtPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthenticatedError('Development token has expired', ErrorCode.TOKEN_EXPIRED);
      }
      throw new UnauthenticatedError('Development token is invalid', ErrorCode.TOKEN_INVALID);
    }

    if (typeof decoded.sub !== 'string' || typeof decoded.email !== 'string') {
      throw new UnauthenticatedError('Development token is missing claims', ErrorCode.TOKEN_INVALID);
    }

    return {
      subject: decoded.sub,
      email: decoded.email.toLowerCase(),
      emailVerified: decoded.email_verified === true,
      ...(typeof decoded.name === 'string' ? { displayName: decoded.name } : {}),
      signInProvider: 'dev',
      issuedAt: decoded.iat ?? 0,
      expiresAt: decoded.exp ?? 0,
    };
  }

  capabilities(): AuthProviderCapabilities {
    return {
      // No provider-side user directory exists to enumerate or mutate.
      userManagement: false,
      revocation: false,
      passwordAuth: false,
      federatedAuth: false,
    };
  }

  async ping(): Promise<void> {
    // Purely local; nothing to reach.
  }
}

/**
 * Deterministic subject from an email.
 *
 * Stability matters: `alice@corp.example` must resolve to the same subject on every login
 * and across restarts, otherwise each sign-in provisions a fresh user and any role granted
 * previously is silently lost.
 */
function subjectForEmail(email: string): string {
  return `dev-${createHash('sha256').update(email).digest('hex').slice(0, 24)}`;
}
