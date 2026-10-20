import { AuditAction } from '@/constants/enums';
import { ErrorCode } from '@/constants/errorCodes';
import type { IAuthPort } from '@/interfaces/auth.port';
import type { IClock } from '@/interfaces/clock.port';
import { toPublicUser, type PublicUser, type User } from '@/models/user.model';
import type { ActorContext } from '@/types/common';
import { ForbiddenError, UnauthenticatedError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';
import type { AuditService } from './audit.service';
import type { TokenService, IssuedSession } from './token.service';
import type { UserService } from './user.service';

const log = createLogger('auth-service');

export interface RequestMetadata {
  ip?: string;
  userAgent?: string;
  correlationId: string;
}

export interface SessionResponse {
  user: PublicUser;
  session: IssuedSession;
}

/**
 * Authentication orchestration.
 *
 * The login flow, end to end:
 *
 *   1. The SPA authenticates against the identity provider (Firebase Google/email sign-in)
 *      and receives a provider ID token. The backend never sees a password.
 *   2. The SPA posts that ID token to `POST /auth/session`.
 *   3. `IAuthPort` verifies it and returns an `ExternalIdentity` — identity only.
 *   4. `UserService` resolves it to a platform user, provisioning on first sign-in, and
 *      attaches the authorisation data (role, department scope) that WE own.
 *   5. `TokenService` issues a short-lived access token and a long-lived refresh token.
 *   6. Every subsequent request presents the access token; no further provider calls.
 *
 * Step 4 is the security boundary: an identity provider says who you are, this platform
 * decides what you may do.
 */
export class AuthService {
  constructor(
    private readonly authProvider: IAuthPort,
    private readonly users: UserService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly clock: IClock,
  ) {}

  /** Exchange a provider ID token for a platform session. */
  async createSession(idToken: string, meta: RequestMetadata): Promise<SessionResponse> {
    const identity = await this.authProvider.verifyIdToken(idToken);

    // A bootstrap actor is needed to attribute the provisioning audit record before the
    // user id exists. It is replaced with the resolved identity inside `resolveOrProvision`.
    const bootstrapActor: ActorContext = {
      userId: 'pending',
      email: identity.email,
      role: 'PENDING',
      correlationId: meta.correlationId,
      ...(meta.ip ? { ip: meta.ip } : {}),
      ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    };

    const user = await this.users.resolveOrProvision(identity, bootstrapActor);
    const session = this.tokens.issueSession(user);

    await this.audit.record({
      action: AuditAction.USER_LOGIN,
      actor: this.actorFor(user, meta),
      summary: `Signed in via ${identity.signInProvider}`,
      target: { type: 'User', id: user.id, name: user.email },
      metadata: { signInProvider: identity.signInProvider, sessionId: session.sessionId },
    });

    log.info(
      { userId: user.id, role: user.role, provider: identity.signInProvider },
      'session issued',
    );

    return { user: toPublicUser(user), session };
  }

  /**
   * Exchange a refresh token for a new access token.
   *
   * The user record is re-read on every refresh, which is what bounds the staleness of the
   * access token's embedded role: a demotion takes effect within one access-token lifetime
   * at worst, and immediately if `sessionsValidFrom` was advanced.
   */
  async refreshSession(refreshToken: string, meta: RequestMetadata): Promise<SessionResponse> {
    const { userId, sessionId, issuedAt } = this.tokens.verifyRefreshToken(refreshToken);

    let user: User;
    try {
      user = await this.users.assertSessionStillValid(userId, issuedAt);
    } catch (error) {
      // Normalise every rejection reason to 401 so a caller cannot distinguish "disabled"
      // from "revoked" from "deleted" — all three mean the same thing to the client, and
      // the distinction is only useful to an attacker probing account states.
      log.debug({ userId, err: error }, 'refresh rejected');
      throw new UnauthenticatedError('Session is no longer valid; sign in again', ErrorCode.TOKEN_INVALID);
    }

    // Reuse the session id so a login and all its refreshes share one audit thread.
    const session = this.tokens.issueSession(user, sessionId);
    void meta;

    return { user: toPublicUser(user), session };
  }

  /** Return the caller's authoritative profile — read from the datastore, not the token. */
  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.getById(userId);
    if (!user.enabled) throw new ForbiddenError('This account has been disabled');
    return toPublicUser(user);
  }

  /**
   * Sign out.
   *
   * `everywhere: false` is a client-side discard — with stateless tokens there is nothing
   * server-side to invalidate for a single device, and pretending otherwise would be
   * security theatre. `everywhere: true` advances the user's session watermark, which
   * genuinely invalidates every outstanding token for that account.
   */
  async logout(
    actor: ActorContext,
    options: { everywhere?: boolean } = {},
  ): Promise<{ revokedEverywhere: boolean }> {
    if (options.everywhere) {
      await this.users.revokeSessions(actor.userId, actor);
    }

    await this.audit.record({
      action: AuditAction.USER_LOGIN,
      actor,
      summary: options.everywhere ? 'Signed out of all devices' : 'Signed out',
      target: { type: 'User', id: actor.userId, name: actor.email },
      metadata: { everywhere: options.everywhere === true },
    });

    return { revokedEverywhere: options.everywhere === true };
  }

  private actorFor(user: User, meta: RequestMetadata): ActorContext {
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      ...(user.displayName ? { displayName: user.displayName } : {}),
      correlationId: meta.correlationId,
      ...(meta.ip ? { ip: meta.ip } : {}),
      ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    };
  }

  /** Exposed so the auth routes can decide whether to mount the dev-login endpoint. */
  get provider(): IAuthPort {
    return this.authProvider;
  }

  get clockRef(): IClock {
    return this.clock;
  }
}
