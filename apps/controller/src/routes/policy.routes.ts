import { Router } from 'express';
import { z } from 'zod';
import type { PolicyController } from '@/controllers/policy.controller';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { requireAdmin } from '@/middleware/authorize';
import { validate } from '@/middleware/validate';
import { idParamSchema, paginationQuerySchema } from '@/models/base.model';
import {
  CreatePolicySchema,
  PolicyListQuerySchema,
  UpdatePolicySchema,
} from '@/models/policy.model';

/**
 * Business policy routes.
 *
 *   GET    /policies             VIEWER
 *   GET    /policies/active      VIEWER
 *   GET    /policies/effective   VIEWER
 *   GET    /policies/:id         VIEWER
 *   POST   /policies             ADMIN + fresh session
 *   PATCH  /policies/:id         ADMIN + fresh session
 *   POST   /policies/:id/activate ADMIN + fresh session
 *   DELETE /policies/:id         ADMIN + fresh session
 *
 * READS are open to every authenticated user by design: the weighting that decides whose
 * bandwidth gets cut must be inspectable by the people it affects. A department lead who
 * cannot see the rules cannot challenge them, and an unchallengeable rule is exactly the
 * opaque behaviour this platform replaces.
 *
 * WRITES are ADMIN-only with a re-validated session. Changing the weight vector changes
 * every future arbitration outcome across the enterprise — this is the single most
 * consequential mutation the API exposes.
 */
export function buildPolicyRouter(deps: {
  controller: PolicyController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();
  const listQuerySchema = paginationQuerySchema.merge(PolicyListQuerySchema);

  router.get('/', deps.auth.authenticate, validate({ query: listQuerySchema }), deps.controller.list);
  router.get('/active', deps.auth.authenticate, deps.controller.active);
  router.get('/effective', deps.auth.authenticate, deps.controller.effective);

  router.get(
    '/:id',
    deps.auth.authenticate,
    validate({ params: idParamSchema }),
    deps.controller.getById,
  );

  router.post(
    '/',
    deps.auth.authenticateFresh,
    requireAdmin,
    validate({ body: CreatePolicySchema }),
    deps.controller.create,
  );

  router.patch(
    '/:id',
    deps.auth.authenticateFresh,
    requireAdmin,
    validate({ params: idParamSchema, body: UpdatePolicySchema }),
    deps.controller.update,
  );

  router.post(
    '/:id/activate',
    deps.auth.authenticateFresh,
    requireAdmin,
    validate({ params: idParamSchema, body: z.object({}).strict().optional() }),
    deps.controller.activate,
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
