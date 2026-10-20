import { Router } from 'express';
import { z } from 'zod';
import type { CapacityController } from '@/controllers/capacity.controller';
import type { ContentionController } from '@/controllers/contention.controller';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { validate } from '@/middleware/validate';
import { idParamSchema, paginationQuerySchema } from '@/models/base.model';
import { ContentionQuerySchema } from '@/models/contention.model';

/**
 * Capacity and contention routes — read-only, VIEWER and above.
 *
 * Nothing here mutates. Contention events are created by the detector from observed
 * network conditions; there is deliberately no endpoint to declare or dismiss one by hand.
 * A human-declarable contention would let an operator trigger arbitration against
 * conditions that do not exist, and a dismissible one would let them hide a condition that
 * does — both of which defeat the auditability the platform is built for.
 */
export function buildCapacityRouter(deps: {
  controller: CapacityController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();

  const seriesQuerySchema = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(500),
  });

  router.get('/', deps.auth.authenticate, deps.controller.current);
  router.get(
    '/series',
    deps.auth.authenticate,
    validate({ query: seriesQuerySchema }),
    deps.controller.series,
  );

  return router;
}

export function buildContentionRouter(deps: {
  controller: ContentionController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();

  // `/current` precedes `/:id` — Express matches in declaration order.
  router.get('/current', deps.auth.authenticate, deps.controller.current);

  router.get(
    '/',
    deps.auth.authenticate,
    validate({ query: paginationQuerySchema.merge(ContentionQuerySchema) }),
    deps.controller.list,
  );

  router.get(
    '/:id',
    deps.auth.authenticate,
    validate({ params: idParamSchema }),
    deps.controller.getById,
  );

  return router;
}
