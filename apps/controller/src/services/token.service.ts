import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { env } from '@/config/env';
import { ErrorCode } from '@/constants/errorCodes';
import { UserRole } from '@/constants/enums';
import type { AuthenticatedPrincipal } from '@/interfaces/auth.port';
import type { IClock } from '@/interfaces/clock.port';
import type { User } from '@/models/user.model';
import { UnauthenticatedError } from '@/utils/errors';

/**
 * Session token service.
 *
 * WHY A SECOND TOKEN AT ALL?
 * ==========================
 * Firebase ID tokens are perfectly good proof of identity, so exchanging them for our own
 * session token needs justification. Three reasons, in order of weight:
 *
 *  1. Authorisation data. Our `role` and `departmentScope` live in Firestore, not in the
 *     provider token. Without a session token, EVERY request would need a user-document
 *     read to resolve the role. At a two-second dashboard poll across a NOC team, that is
 *     tens of thousands of reads per hour for data that changes monthly.
 *
 *  2. Verification cost. `verifyIdToken` requires Google's public keys and, when the token
 *     is near expiry or revocation checking is on, a network round trip. HS256 verification
 *     against a local secret is measured in microseconds.
 *
 *  3. Provider independence. Swapping Firebase for Entra ID changes only the login
 *     exchange; every downstream authorisation check keeps working unchanged.
 *
 * The cost is bounded staleness: a role revocation takes effect within `JWT_TTL_SECONDS`
 * (default one hour). For immediate revocation, `sessionsValidFrom` on the user document
 * invalidates every token issued before it — checked on refresh, and on every request for
 * privileged operations.
 */

export const TokenType = { ACCESS: 'access', REFRESH: 'refresh' } as const;
export type TokenType = (typeof TokenType)[keyof typeof TokenType];

interface AccessTokenClaims extends JwtPayload {
  typ: typeof TokenType.ACCESS;
  sub: string;
  sid: string;
  /** Provider subject, retained for correlation with IdP audit logs. */
  psub: string;
  email: string;
  role: UserRole;
  scope: string[];
  name?: string;
}

interface RefreshTokenClaims extends JwtPayload {
  typ: typeof TokenType.REFRESH;
  sub: string;
  sid: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  expiresInSeconds: number;
  sessionId: string;
  tokenType: 'Bearer';
}

export class TokenService {
  private readonly secret: string;

  constructor(private readonly clock: IClock) {
    this.secret = env.JWT_SECRET;
  }

  /** Issues a fresh access/refresh pair. `sessionId` is reused across refreshes. */
  issueSession(user: User, sessionId: string = randomUUID()): IssuedSession {
    const issuedAt = Math.floor(this.clock.now() / 1000);
    const expiresAt = issuedAt + env.JWT_TTL_SECONDS;

    const accessClaims: AccessTokenClaims = {
      typ: TokenType.ACCESS,
      sub: user.id,
      sid: sessionId,
      psub: user.subject,
      email: user.email,
      role: user.role,
      scope: user.departmentScope,
      ...(user.displayName ? { name: user.displayName } : {}),
    };

    const refreshClaims: RefreshTokenClaims = {
      typ: TokenType.REFRESH,
      sub: user.id,
      sid: sessionId,
    };

    return {
      accessToken: this.sign(accessClaims, env.JWT_TTL_SECONDS, issuedAt),
      refreshToken: this.sign(refreshClaims, env.REFRESH_TTL_SECONDS, issuedAt),
      expiresAt,
      expiresInSeconds: env.JWT_TTL_SECONDS,
      sessionId,
      tokenType: 'Bearer',
    };
  }

  /**
   * Verify an access token and project it into a principal.
   * @throws {UnauthenticatedError} on any failure — expired, malformed, wrong type,
   *         wrong issuer/audience, or bad signature.
   */
  verifyAccessToken(token: string): AuthenticatedPrincipal {
    const claims = this.verify<AccessTokenClaims>(token);

    // A refresh token presented as a bearer credential must be rejected outright: it has a
    // two-week lifetime and carries no role, so accepting it would both extend the
    // privilege window and produce a principal with an undefined role.
    if (claims.typ !== TokenType.ACCESS) {
      throw new UnauthenticatedError('Invalid token type', ErrorCode.TOKEN_INVALID);
    }

    if (!claims.sub || !claims.sid || !claims.email || !claims.role) {
      throw new UnauthenticatedError('Token is missing required claims', ErrorCode.TOKEN_INVALID);
    }

    if (!Object.values(UserRole).includes(claims.role)) {
      throw new UnauthenticatedError('Token carries an unrecognised role', ErrorCode.TOKEN_INVALID);
    }

    return {
      userId: claims.sub,
      subject: claims.psub ?? claims.sub,
      email: claims.email,
      role: claims.role,
      ...(claims.name ? { displayName: claims.name } : {}),
      departmentScope: Array.isArray(claims.scope) ? claims.scope : [],
      issuedAt: claims.iat ?? 0,
      expiresAt: claims.exp ?? 0,
      sessionId: claims.sid,
    };
  }

  /** Verify a refresh token. Returns the identifiers needed to re-read the user. */
  verifyRefreshToken(token: string): { userId: string; sessionId: string; issuedAt: number } {
    const claims = this.verify<RefreshTokenClaims>(token);

    if (claims.typ !== TokenType.REFRESH) {
      throw new UnauthenticatedError('Invalid token type', ErrorCode.TOKEN_INVALID);
    }
    if (!claims.sub || !claims.sid) {
      throw new UnauthenticatedError('Token is missing required claims', ErrorCode.TOKEN_INVALID);
    }

    return { userId: claims.sub, sessionId: claims.sid, issuedAt: claims.iat ?? 0 };
  }

  /**
   * True when a token issued at `issuedAt` (epoch seconds) predates the user's
   * `sessionsValidFrom` watermark and must therefore be rejected.
   */
  isSuperseded(issuedAtSeconds: number, sessionsValidFrom: string | undefined): boolean {
    if (!sessionsValidFrom) return false;
    const watermark = Date.parse(sessionsValidFrom);
    if (Number.isNaN(watermark)) return false;
    // Compare at whole-second resolution: `iat` is truncated to seconds, so a token issued
    // in the same second as the watermark would otherwise be spuriously rejected.
    return issuedAtSeconds < Math.floor(watermark / 1000);
  }

  private sign(claims: JwtPayload, ttlSeconds: number, issuedAt: number): string {
    const options: SignOptions = {
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresIn: ttlSeconds,
    };
    return jwt.sign({ ...claims, iat: issuedAt }, this.secret, options);
  }

  private verify<T extends JwtPayload>(token: string): T {
    try {
      // Pinning `algorithms` is essential. Without it, a token with `"alg":"none"` — or,
      // when the secret is a public key, an HS256 token signed with that public key — is
      // accepted. This is the classic JWT algorithm-confusion vulnerability.
      //
      // `clockTimestamp` routes expiry evaluation through the injected clock. Without it,
      // issuance would use `IClock` while verification silently used the system clock —
      // which makes the clock port a lie and any test using a fixed clock fail in a way
      // that looks like an auth bug.
      return jwt.verify(token, this.secret, {
        algorithms: ['HS256'],
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        clockTolerance: 5,
        clockTimestamp: Math.floor(this.clock.now() / 1000),
      }) as T;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthenticatedError('Session has expired', ErrorCode.TOKEN_EXPIRED);
      }
      throw new UnauthenticatedError('Session token is invalid', ErrorCode.TOKEN_INVALID);
    }
  }
}
