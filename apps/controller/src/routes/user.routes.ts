import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@/constants/enums';
import type { UserController } from '@/controllers/user.controller';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { requireAdmin, requireSelfOrRole } from '@/middleware/authorize';
import { validate } from '@/middleware/validate';
import { idParamSchema, paginationQuerySchema } from '@/models/base.model';
import { UpdateOwnProfileSchema, UpdateUserSchema, UserListQuerySchema } from '@/models/user.model';

/**
 * User management routes.
 *
 * AUTHORISATION SUMMARY — the security-relevant part of this file:
 *
 *   GET    /users                    ADMIN
 *   GET    /users/:id                self, or ADMIN
 *   PATCH  /users/me                 self  (profile & notification preferences only)
 *   PATCH  /users/:id                ADMIN + fresh session   (role / enabled / scope)
 *   POST   /users/:id/revoke-sessions ADMIN + fresh session
 *   DELETE /users/:id                ADMIN + fresh session
 *
 * The three mutating administrative routes use `authenticateFresh`, which re-reads the
 * user record and re-checks `enabled` and the session watermark on every call. That extra
 * datastore read is worth paying so that an administrator demoted thirty seconds ago
 * cannot use their still-valid access token to grant themselves the role back.
 *
 * `/users/me` is declared BEFORE `/users/:id`; Express matches in declaration order, so the
 * reverse would make `me` a valid `:id` and route self-service edits into the
 * administrator handler.
 */
export function buildUserRouter(deps: { controller: UserController; auth: AuthMiddleware }): Router {
  const router = Router();

  const listQuerySchema = paginationQuerySchema.merge(UserListQuerySchema);

  router.get(
    '/',
    deps.auth.authenticate,
    requireAdmin,
    validate({ query: listQuerySchema }),
    deps.controller.list,
  );

  router.patch(
    '/me',
    deps.auth.authenticate,
    validate({ body: UpdateOwnProfileSchema }),
    deps.controller.updateOwnProfile,
  );

  router.get(
    '/:id',
    deps.auth.authenticate,
    requireSelfOrRole('id', UserRole.ADMIN),
    validate({ params: idParamSchema }),
    deps.controller.getById,
  );

  router.patch(
    '/:id',
    deps.auth.authenticateFresh,
    requireAdmin,
    validate({ params: idParamSchema, body: UpdateUserSchema }),
    deps.controller.update,
  );

  router.post(
    '/:id/revoke-sessions',
    deps.auth.authenticateFresh,
    requireAdmin,
    validate({ params: idParamSchema, body: z.object({}).strict().optional() }),
    deps.controller.revokeSessions,
  );

  router.delete(
    '/:id',
    deps.auth.authenticateFresh,
    requireAdmin,
    validate({ params: idParamSchema }),
    deps.controller.remove,
  );

  return router;
}
