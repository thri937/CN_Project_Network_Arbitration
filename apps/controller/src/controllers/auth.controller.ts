import type { Request, Response } from 'express';
import { isDevAuthProvider } from '@/auth';
import type { AuthService, RequestMetadata } from '@/services/auth.service';
import { requireActor, requirePrincipal } from '@/middleware/authenticate';
import { asyncHandler } from '@/utils/asyncHandler';
import { ok } from '@/utils/http';
import { NotImplementedError } from '@/utils/errors';
import type {
  CreateSessionPayload,
  DevLoginPayload,
  LogoutPayload,
  RefreshSessionPayload,
} from '@/validators/auth.validator';

/**
 * Authentication endpoints.
 *
 * Controllers in this codebase are thin by rule: extract validated input, call one service
 * method, shape the response. No business logic, no datastore access, no conditionals
 * beyond presentation. Anything more belongs in a service, where it is unit-testable
 * without an HTTP layer.
 *
 * Note the absence of a password endpoint. Credentials are handled entirely by the
 * identity provider's client SDK; this backend never receives, stores or transports a
 * password, which removes an entire class of liability.
 */
export function createAuthController(deps: { auth: AuthService }) {
  const metaFrom = (req: Request): RequestMetadata => ({
    correlationId: req.correlationId,
    ...(req.ip ? { ip: req.ip } : {}),
    ...(typeof req.headers['user-agent'] === 'string'
      ? { userAgent: req.headers['user-agent'] }
      : {}),
  });

  return {
    /** POST /auth/session — exchange a provider ID token for a platform session. */
    createSession: asyncHandler(async (req: Request, res: Response) => {
      const { idToken } = req.body as CreateSessionPayload;
      const result = await deps.auth.createSession(idToken, metaFrom(req));
      ok(req, res, result);
    }),

    /** POST /auth/refresh — exchange a refresh token for a new access token. */
    refresh: asyncHandler(async (req: Request, res: Response) => {
      const { refreshToken } = req.body as RefreshSessionPayload;
      const result = await deps.auth.refreshSession(refreshToken, metaFrom(req));
      ok(req, res, result);
    }),

    /** GET /auth/me — the caller's authoritative profile, read fresh from the datastore. */
    me: asyncHandler(async (req: Request, res: Response) => {
      const principal = requirePrincipal(req);
      ok(req, res, await deps.auth.me(principal.userId));
    }),

    /** POST /auth/logout */
    logout: asyncHandler(async (req: Request, res: Response) => {
      const { everywhere } = req.body as LogoutPayload;
      const result = await deps.auth.logout(requireActor(req), { everywhere });
      ok(req, res, result);
    }),

    /**
     * POST /auth/dev-login — DEVELOPMENT ONLY.
     *
     * Mounted only when the dev auth adapter is active. The runtime guard here is
     * redundant with the mount condition and with the adapter's own constructor check;
     * that redundancy is intentional for an endpoint that issues identities on demand.
     */
    devLogin: asyncHandler(async (req: Request, res: Response) => {
      const provider = deps.auth.provider;
      if (!isDevAuthProvider(provider)) {
        throw new NotImplementedError('Development sign-in');
      }

      const payload = req.body as DevLoginPayload;
      const idToken = provider.issueDevToken(payload);
      const result = await deps.auth.createSession(idToken, metaFrom(req));

      ok(req, res, {
        ...result,
        warning:
          'Development sign-in is active. Any email may authenticate without a password. ' +
          'Set AUTH_DRIVER=firebase for any deployment reachable by others.',
      });
    }),
  };
}

export type AuthController = ReturnType<typeof createAuthController>;
