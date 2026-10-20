import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode } from '@/constants/errorCodes';
import type { AuthenticatedPrincipal } from '@/interfaces/auth.port';
import type { TokenService } from '@/services/token.service';
import type { UserService } from '@/services/user.service';
import type { ActorContext } from '@/types/common';
import { ForbiddenError, UnauthenticatedError } from '@/utils/errors';

/**
 * Authentication middleware.
 *
 * Populates `req.principal` and `req.actor`. These are the ONLY sanctioned sources of
 * identity in the application — no controller or service may re-parse the Authorization
 * header, and none does.
 *
 * TWO TIERS, DELIBERATELY
 * =======================
 * `authenticate` verifies the session token's signature and expiry only. No datastore
 * read. This is what makes a two-second dashboard poll affordable.
 *
 * `authenticateFresh` additionally re-reads the user record and re-checks `enabled` and
 * the session watermark. It costs one read per request, so it is applied only to
 * privileged, low-frequency operations: role changes, slice deletion, manual arbitration
 * override. The result is that a revoked administrator cannot use a still-valid access
 * token to do anything that matters, while ordinary reads stay cheap.
 */
export interface AuthMiddlewareDeps {
  tokens: TokenService;
  users: UserService;
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  const attach = (req: Request, principal: AuthenticatedPrincipal): void => {
    req.principal = principal;
    req.actor = toActor(principal, req);
  };

  const authenticate: RequestHandler = (req, _res, next) => {
    try {
      attach(req, deps.tokens.verifyAccessToken(extractBearerToken(req)));
      next();
    } catch (error) {
      next(error);
    }
  };

  const authenticateFresh: RequestHandler = async (req, _res, next) => {
    try {
      const principal = deps.tokens.verifyAccessToken(extractBearerToken(req));
      // Re-reads the record and enforces `enabled` + `sessionsValidFrom`.
      const user = await deps.users.assertSessionStillValid(principal.userId, principal.issuedAt);

      // Use the CURRENT role from the datastore, not the role frozen into the token. A
      // token minted before a demotion must not carry the old privileges into a
      // privileged operation.
      attach(req, {
        ...principal,
        role: user.role,
        departmentScope: user.departmentScope,
        ...(user.displayName ? { displayName: user.displayName } : {}),
      });
      next();
    } catch (error) {
      next(error);
    }
  };

  /**
   * Attaches a principal when a valid token is present, but does not require one.
   * Used by endpoints whose response varies for signed-in users without being restricted.
   */
  const optionalAuthenticate: RequestHandler = (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header) return next();
    try {
      attach(req, deps.tokens.verifyAccessToken(extractBearerToken(req)));
    } catch {
      // A malformed optional credential is ignored rather than fatal — that is the point
      // of "optional". The request proceeds unauthenticated.
    }
    next();
  };

  return { authenticate, authenticateFresh, optionalAuthenticate };
}

export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;

/**
 * Extract a bearer token.
 *
 * The scheme comparison is case-insensitive per RFC 7235, and the token is required to be
 * a single non-empty segment so that `Bearer a b` cannot smuggle a second value.
 */
export function extractBearerToken(req: Request): string {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') {
    throw new UnauthenticatedError('Authorization header is required');
  }

  const parts = header.split(' ').filter(Boolean);
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== 'bearer') {
    throw new UnauthenticatedError(
      'Authorization header must use the Bearer scheme',
      ErrorCode.TOKEN_INVALID,
    );
  }

  return parts[1]!;
}

/** Project the principal onto the actor context threaded into services and audit records. */
export function toActor(principal: AuthenticatedPrincipal, req: Request): ActorContext {
  return {
    userId: principal.userId,
    email: principal.email,
    role: principal.role,
    ...(principal.displayName ? { displayName: principal.displayName } : {}),
    correlationId: req.correlationId,
    ...(req.ip ? { ip: req.ip } : {}),
    ...(typeof req.headers['user-agent'] === 'string'
      ? { userAgent: req.headers['user-agent'] }
      : {}),
  };
}

/**
 * Retrieve the authenticated principal, or throw.
 *
 * Controllers call this instead of reading `req.principal` directly. The throw is a
 * programming-error guard: reaching a protected handler without a principal means the
 * route was mounted without `authenticate`, and failing loudly at the first request is far
 * better than silently treating the caller as anonymous.
 */
export function requirePrincipal(req: Request): AuthenticatedPrincipal {
  if (!req.principal) {
    throw new UnauthenticatedError('Authentication required');
  }
  return req.principal;
}

export function requireActor(req: Request): ActorContext {
  if (!req.actor) {
    throw new UnauthenticatedError('Authentication required');
  }
  return req.actor;
}

/** Guard for department-scoped access; empty scope means unrestricted. */
export function assertDepartmentAccess(req: Request, departmentId: string): void {
  const principal = requirePrincipal(req);
  if (principal.departmentScope.length === 0) return;
  if (principal.departmentScope.includes(departmentId)) return;
  throw new ForbiddenError('You do not have access to this department', { departmentId });
}

/** Express handler wrapper for async middleware, mirroring `utils/asyncHandler`. */
export function asyncMiddleware(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
