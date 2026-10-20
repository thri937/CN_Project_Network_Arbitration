import { Router } from 'express';
import type { DepartmentController } from '@/controllers/department.controller';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { requireAdmin, requireManager } from '@/middleware/authorize';
import { validate } from '@/middleware/validate';
import { idParamSchema, paginationQuerySchema } from '@/models/base.model';
import {
  CreateDepartmentSchema,
  DepartmentListQuerySchema,
  UpdateDepartmentSchema,
} from '@/models/department.model';

/**
 * Department routes.
 *
 *   GET    /departments          VIEWER   (any authenticated user)
 *   GET    /departments/summary  VIEWER
 *   GET    /departments/:id      VIEWER
 *   POST   /departments          MANAGER
 *   PATCH  /departments/:id      MANAGER
 *   DELETE /departments/:id      ADMIN + fresh session
 *
 * Deletion is ADMIN-only and re-validates the session, because a department carries the
 * business justification for every arbitration decision touching its slices. Removing one
 * is closer to a governance act than to routine network operations.
 *
 * `/summary` precedes `/:id`: Express matches in declaration order, so the reverse would
 * make `summary` a candidate department id.
 */
export function buildDepartmentRouter(deps: {
  controller: DepartmentController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();
  const listQuerySchema = paginationQuerySchema.merge(DepartmentListQuerySchema);

  router.get(
    '/',
    deps.auth.authenticate,
    validate({ query: listQuerySchema }),
    deps.controller.list,
  );

  router.get('/summary', deps.auth.authenticate, deps.controller.summary);

  router.get(
    '/:id',
    deps.auth.authenticate,
    validate({ params: idParamSchema }),
    deps.controller.getById,
  );

  router.post(
    '/',
    deps.auth.authenticate,
    requireManager,
    validate({ body: CreateDepartmentSchema }),
    deps.controller.create,
  );

  router.patch(
    '/:id',
    deps.auth.authenticate,
    requireManager,
    validate({ params: idParamSchema, body: UpdateDepartmentSchema }),
    deps.controller.update,
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
