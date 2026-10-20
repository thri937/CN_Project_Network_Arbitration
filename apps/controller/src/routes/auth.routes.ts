import { Router } from 'express';
import { isDevAuthProvider } from '@/auth';
import type { AuthController } from '@/controllers/auth.controller';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { authLimiter } from '@/middleware/rateLimiter';
import { validate } from '@/middleware/validate';
import type { AuthService } from '@/services/auth.service';
import {
  createSessionSchema,
  devLoginSchema,
  logoutSchema,
  refreshSessionSchema,
} from '@/validators/auth.validator';
import { createLogger } from '@/utils/logger';

const log = createLogger('auth-routes');

/**
 * Authentication routes.
 *
 * PUBLIC (no session required):
 *   POST /auth/session   exchange a provider ID token for a platform session
 *   POST /auth/refresh   exchange a refresh token for a new access token
 *   POST /auth/dev-login development adapter only
 *
 * AUTHENTICATED:
 *   GET  /auth/me        the caller's profile
 *   POST /auth/logout
 *
 * The three public endpoints carry the strict `authLimiter` (IP-keyed, low ceiling). They
 * are the only unauthenticated write endpoints in the platform and therefore the only
 * brute-force surface.
 */
export function buildAuthRouter(deps: {
  controller: AuthController;
  auth: AuthMiddleware;
  authService: AuthService;
}): Router {
  const router = Router();

  router.post(
    '/session',
    authLimiter,
    validate({ body: createSessionSchema }),
    deps.controller.createSession,
  );

  router.post(
    '/refresh',
    authLimiter,
    validate({ body: refreshSessionSchema }),
    deps.controller.refresh,
  );

  router.get('/me', deps.auth.authenticate, deps.controller.me);

  router.post(
    '/logout',
    deps.auth.authenticate,
    validate({ body: logoutSchema }),
    deps.controller.logout,
  );

  /**
   * Mounted conditionally. When `AUTH_DRIVER=firebase`, this route does not exist at all —
   * it returns 404 rather than 501, so the endpoint's very existence does not advertise
   * that a development bypass is compiled in.
   */
  if (isDevAuthProvider(deps.authService.provider)) {
    log.warn(
      'mounting POST /auth/dev-login — development sign-in is ENABLED for this process',
    );
    router.post(
      '/dev-login',
      authLimiter,
      validate({ body: devLoginSchema }),
      deps.controller.devLogin,
    );
  }

  return router;
}
