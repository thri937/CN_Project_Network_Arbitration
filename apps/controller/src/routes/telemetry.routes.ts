import { Router } from 'express';
import { z } from 'zod';
import type { TelemetryController } from '@/controllers/telemetry.controller';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { requireManager } from '@/middleware/authorize';
import { validate } from '@/middleware/validate';
import { paginationQuerySchema } from '@/models/base.model';
import {
  InjectFaultSchema,
  SetGlobalLoadSchema,
  TelemetryQuerySchema,
} from '@/models/telemetry.model';

/**
 * Telemetry routes.
 *
 *   GET    /telemetry/live             VIEWER
 *   GET    /telemetry/live/:sliceId    VIEWER
 *   GET    /telemetry/provider         VIEWER
 *   GET    /telemetry/series/:sliceId  VIEWER
 *   GET    /telemetry                  VIEWER
 *   POST   /telemetry/faults           MANAGER   (synthetic provider only)
 *   DELETE /telemetry/faults/:sliceId  MANAGER   (synthetic provider only)
 *   POST   /telemetry/load             MANAGER   (synthetic provider only)
 *
 * Reads are open to any authenticated user — the NOC wall display is a VIEWER session.
 *
 * The three mutating endpoints drive the modelled network into contention, which causes
 * real arbitration decisions to be taken and real audit records to be written. They are
 * therefore MANAGER-gated even though the "network" is synthetic: the consequences inside
 * the platform are indistinguishable from those of genuine congestion.
 */
export function buildTelemetryRouter(deps: {
  controller: TelemetryController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();

  const sliceParamSchema = z.object({ sliceId: z.string().trim().min(1).max(128) });
  const seriesQuerySchema = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(500),
  });

  router.get('/live', deps.auth.authenticate, deps.controller.live);

  router.get(
    '/live/:sliceId',
    deps.auth.authenticate,
    validate({ params: sliceParamSchema }),
    deps.controller.liveSlice,
  );

  router.get('/provider', deps.auth.authenticate, deps.controller.provider);

  router.get(
    '/series/:sliceId',
    deps.auth.authenticate,
    validate({ params: sliceParamSchema, query: seriesQuerySchema }),
    deps.controller.series,
  );

  router.get(
    '/',
    deps.auth.authenticate,
    validate({ query: paginationQuerySchema.merge(TelemetryQuerySchema) }),
    deps.controller.query,
  );

  router.post(
    '/faults',
    deps.auth.authenticate,
    requireManager,
    validate({ body: InjectFaultSchema }),
    deps.controller.injectFault,
  );

  router.delete(
    '/faults/:sliceId',
    deps.auth.authenticate,
    requireManager,
    validate({ params: sliceParamSchema }),
    deps.controller.clearFault,
  );

  router.post(
    '/load',
    deps.auth.authenticate,
    requireManager,
    validate({ body: SetGlobalLoadSchema }),
    deps.controller.setLoad,
  );

  return router;
}
