import { Router } from 'express';
import { z } from 'zod';
import type { SliceController } from '@/controllers/slice.controller';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { requireAdmin, requireManager } from '@/middleware/authorize';
import { validate } from '@/middleware/validate';
import { idParamSchema, paginationQuerySchema } from '@/models/base.model';
import {
  CreateSliceSchema,
  PauseSliceSchema,
  SliceListQuerySchema,
  UpdateSliceSchema,
} from '@/models/slice.model';

/**
 * Slice routes.
 *
 *   GET    /slices             VIEWER
 *   GET    /slices/headroom    VIEWER
 *   GET    /slices/topology    VIEWER
 *   GET    /slices/:id         VIEWER
 *   POST   /slices             MANAGER
 *   PATCH  /slices/:id         MANAGER
 *   POST   /slices/:id/pause   MANAGER
 *   POST   /slices/:id/resume  MANAGER
 *   DELETE /slices/:id         ADMIN + fresh session
 *
 * Pause and resume are MANAGER operations: they are routine network operations that a NOC
 * shift lead must be able to perform at 03:00 without escalating. Deletion is ADMIN-only
 * because it removes the subject of past arbitration decisions.
 *
 * The two literal paths precede `/:id` — Express matches in declaration order.
 */
export function buildSliceRouter(deps: {
  controller: SliceController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();
  const listQuerySchema = paginationQuerySchema.merge(SliceListQuerySchema);

  router.get('/', deps.auth.authenticate, validate({ query: listQuerySchema }), deps.controller.list);
  router.get('/headroom', deps.auth.authenticate, deps.controller.headroom);
  router.get('/topology', deps.auth.authenticate, deps.controller.topology);

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
    validate({ body: CreateSliceSchema }),
    deps.controller.create,
  );

  router.patch(
    '/:id',
    deps.auth.authenticate,
    requireManager,
    validate({ params: idParamSchema, body: UpdateSliceSchema }),
    deps.controller.update,
  );

  router.post(
    '/:id/pause',
    deps.auth.authenticate,
    requireManager,
    validate({ params: idParamSchema, body: PauseSliceSchema }),
    deps.controller.pause,
  );

  router.post(
    '/:id/resume',
    deps.auth.authenticate,
    requireManager,
    validate({ params: idParamSchema, body: z.object({}).strict().optional() }),
    deps.controller.resume,
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
