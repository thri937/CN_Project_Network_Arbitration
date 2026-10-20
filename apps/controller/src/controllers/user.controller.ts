import type { Request, Response } from 'express';
import type { UserRole } from '@/constants/enums';
import { toPublicUser } from '@/models/user.model';
import type { UpdateOwnProfilePayload, UpdateUserPayload } from '@/models/user.model';
import { requireActor, requirePrincipal } from '@/middleware/authenticate';
import type { UserService } from '@/services/user.service';
import { asyncHandler } from '@/utils/asyncHandler';
import { noContent, ok, paginated } from '@/utils/http';
import type { PaginationQuery } from '@/models/base.model';

/**
 * User management endpoints.
 *
 * Every response passes through `toPublicUser`, which strips the identity-provider subject
 * and any internal bookkeeping. Serialising the raw entity would leak the provider's
 * primary key to the browser for no functional benefit.
 */
export function createUserController(deps: { users: UserService }) {
  return {
    /** GET /users — administrators only. */
    list: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as PaginationQuery & {
        role?: UserRole;
        enabled?: boolean;
      };

      const page = await deps.users.list(
        {
          ...(query.role ? { role: query.role } : {}),
          ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
        },
        { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
      );

      paginated(req, res, { ...page, items: page.items.map(toPublicUser) }, query.limit);
    }),

    /** GET /users/:id — self, or administrator. */
    getById: asyncHandler(async (req: Request, res: Response) => {
      const user = await deps.users.getById(req.params.id as string);
      ok(req, res, toPublicUser(user));
    }),

    /** PATCH /users/:id — administrators only; role, status and department scope. */
    update: asyncHandler(async (req: Request, res: Response) => {
      const updated = await deps.users.update(
        req.params.id as string,
        req.body as UpdateUserPayload,
        requireActor(req),
      );
      ok(req, res, toPublicUser(updated));
    }),

    /** PATCH /users/me — self-service profile and notification preferences. */
    updateOwnProfile: asyncHandler(async (req: Request, res: Response) => {
      const principal = requirePrincipal(req);
      const updated = await deps.users.updateOwnProfile(
        principal.userId,
        req.body as UpdateOwnProfilePayload,
        requireActor(req),
      );
      ok(req, res, toPublicUser(updated));
    }),

    /** POST /users/:id/revoke-sessions — force sign-out across all devices. */
    revokeSessions: asyncHandler(async (req: Request, res: Response) => {
      await deps.users.revokeSessions(req.params.id as string, requireActor(req));
      noContent(res);
    }),

    /** DELETE /users/:id */
    remove: asyncHandler(async (req: Request, res: Response) => {
      await deps.users.delete(req.params.id as string, requireActor(req));
      noContent(res);
    }),
  };
}

export type UserController = ReturnType<typeof createUserController>;
