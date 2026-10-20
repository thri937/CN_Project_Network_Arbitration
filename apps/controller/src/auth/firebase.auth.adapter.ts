import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import { ErrorCode } from '@/constants/errorCodes';
import { getFirebaseAuth } from '@/firebase/admin';
import type {
  AuthProviderCapabilities,
  ExternalIdentity,
  IAuthPort,
} from '@/interfaces/auth.port';
import { ForbiddenError, InternalError, UnauthenticatedError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';

const log = createLogger('firebase-auth');

/**
 * Firebase Authentication adapter — the production identity provider.
 *
 * Supports Google federated sign-in and email/password out of the box, which is exactly
 * the requirement, and gives the enterprise a migration path to SAML/OIDC without changing
 * anything above this file.
 *
 * `checkRevoked` is enabled on token verification. It costs one extra call against the
 * Firebase user record, but it is what makes "disable this account NOW" actually
 * immediate at the provider — the local `enabled` flag covers our side, and this covers
 * theirs. For a platform that can degrade a hospital's network slice, that is the correct
 * trade.
 */
export class FirebaseAuthAdapter implements IAuthPort {
  readonly name = 'firebase';

  private readonly auth: Auth;

  constructor(auth?: Auth) {
    this.auth = auth ?? getFirebaseAuth();
  }

  async verifyIdToken(idToken: string): Promise<ExternalIdentity> {
    if (!idToken || typeof idToken !== 'string') {
      throw new UnauthenticatedError('An ID token is required', ErrorCode.TOKEN_INVALID);
    }

    let decoded: DecodedIdToken;
    try {
      decoded = await this.auth.verifyIdToken(idToken, true);
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      log.debug({ code }, 'ID token verification failed');

      if (code === 'auth/id-token-expired') {
        throw new UnauthenticatedError('Sign-in has expired; sign in again', ErrorCode.TOKEN_EXPIRED);
      }
      if (code === 'auth/id-token-revoked' || code === 'auth/user-disabled') {
        throw new ForbiddenError('This account has been disabled');
      }
      throw new UnauthenticatedError('Sign-in credentials are invalid', ErrorCode.TOKEN_INVALID);
    }

    // Firebase permits accounts without an email (phone, anonymous). This platform is
    // email-identified — audit records name a person — so such accounts are rejected here
    // rather than producing a user row with an empty identity.
    if (!decoded.email) {
      throw new ForbiddenError('This account has no email address and cannot be used here');
    }

    return {
      subject: decoded.uid,
      email: decoded.email.toLowerCase(),
      emailVerified: decoded.email_verified === true,
      ...(decoded.name ? { displayName: String(decoded.name) } : {}),
      ...(decoded.picture ? { photoUrl: String(decoded.picture) } : {}),
      signInProvider: decoded.firebase?.sign_in_provider ?? 'unknown',
      issuedAt: decoded.iat,
      expiresAt: decoded.exp,
      claims: decoded as unknown as Record<string, unknown>,
    };
  }

  capabilities(): AuthProviderCapabilities {
    return {
      userManagement: true,
      revocation: true,
      passwordAuth: true,
      federatedAuth: true,
    };
  }

  async getUserBySubject(subject: string): Promise<ExternalIdentity | null> {
    try {
      const record = await this.auth.getUser(subject);
      return this.fromUserRecord(record);
    } catch (error) {
      if ((error as { code?: string }).code === 'auth/user-not-found') return null;
      throw new InternalError('Failed to look up user by subject', error);
    }
  }

  async getUserByEmail(email: string): Promise<ExternalIdentity | null> {
    try {
      const record = await this.auth.getUserByEmail(email.toLowerCase());
      return this.fromUserRecord(record);
    } catch (error) {
      if ((error as { code?: string }).code === 'auth/user-not-found') return null;
      throw new InternalError('Failed to look up user by email', error);
    }
  }

  async setEnabled(subject: string, enabled: boolean): Promise<void> {
    await this.auth.updateUser(subject, { disabled: !enabled });
    if (!enabled) {
      // Disabling alone leaves existing ID tokens valid until they expire (up to an hour).
      // Revoking refresh tokens, combined with `checkRevoked` above, closes that window.
      await this.auth.revokeRefreshTokens(subject);
    }
    log.info({ subject, enabled }, 'provider account status changed');
  }

  async revokeSessions(subject: string): Promise<void> {
    await this.auth.revokeRefreshTokens(subject);
    log.info({ subject }, 'provider refresh tokens revoked');
  }

  async ping(): Promise<void> {
    // `listUsers(1)` is the cheapest call that exercises credentials and IAM end to end.
    await this.auth.listUsers(1);
  }

  private fromUserRecord(record: {
    uid: string;
    email?: string;
    emailVerified: boolean;
    displayName?: string;
    photoURL?: string;
    disabled: boolean;
    providerData: { providerId: string }[];
  }): ExternalIdentity {
    return {
      subject: record.uid,
      email: (record.email ?? '').toLowerCase(),
      emailVerified: record.emailVerified,
      ...(record.displayName ? { displayName: record.displayName } : {}),
      ...(record.photoURL ? { photoUrl: record.photoURL } : {}),
      signInProvider: record.providerData[0]?.providerId ?? 'unknown',
      issuedAt: 0,
      expiresAt: 0,
      claims: { disabled: record.disabled },
    };
  }
}
