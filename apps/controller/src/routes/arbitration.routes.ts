import { Router } from 'express';
import { z } from 'zod';
import type { ArbitrationController } from '@/controllers/arbitration.controller';
import type { AuditController } from '@/controllers/audit.controller';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { requireAdmin, requireManager } from '@/middleware/authorize';
import { validate } from '@/middleware/validate';
import { idParamSchema, paginationQuerySchema } from '@/models/base.model';
import {
  ArbitrationQuerySchema,
  OverrideDecisionSchema,
  TriggerArbitrationSchema,
} from '@/models/arbitrationDecision.model';
import { AuditLogQuerySchema } from '@/models/auditLog.model';
import { MarkReadSchema, NotificationQuerySchema } from '@/models/notification.model';

/**
 * Arbitration routes.
 *
 *   GET  /arbitration                      VIEWER
 *   GET  /arbitration/recent               VIEWER
 *   GET  /arbitration/summary              VIEWER
 *   GET  /arbitration/contention/:id       VIEWER
 *   GET  /arbitration/:id                  VIEWER
 *   POST /arbitration/simulate             MANAGER
 *   POST /arbitration/trigger              MANAGER + fresh session
 *   POST /arbitration/:id/override         ADMIN   + fresh session
 *
 * READS ARE OPEN TO EVERY AUTHENTICATED USER, deliberately. A department head must be able
 * to read the decision that degraded their slice, including its rationale, its factor
 * breakdown and the alternatives that were rejected. A platform whose justifications are
 * visible only to its operators is not auditable in any useful sense.
 *
 * Writes are gated and session-revalidated: triggering arbitration and overriding a
 * decision both change the network.
 */
export function buildArbitrationRouter(deps: {
  controller: ArbitrationController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();

  const rangeQuery = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  });

  // Literal paths precede `/:id` — Express matches in declaration order.
  router.get('/recent', deps.auth.authenticate, deps.controller.recent);
  router.get(
    '/summary',
    deps.auth.authenticate,
    validate({ query: rangeQuery }),
    deps.controller.summary,
  );

  router.post(
    '/simulate',
    deps.auth.authenticate,
    requireManager,
    deps.controller.simulate,
  );

  router.post(
    '/trigger',
    deps.auth.authenticateFresh,
    requireManager,
    validate({ body: TriggerArbitrationSchema }),
    deps.controller.trigger,
  );

  router.get(
    '/contention/:contentionId',
    deps.auth.authenticate,
    validate({ params: z.object({ contentionId: z.string().trim().min(1).max(128) }) }),
    deps.controller.forContention,
  );

  router.get(
    '/',
    deps.auth.authenticate,
    validate({ query: paginationQuerySchema.merge(ArbitrationQuerySchema) }),
    deps.controller.list,
  );

  router.get(
    '/:id',
    deps.auth.authenticate,
    validate({ params: idParamSchema }),
    deps.controller.getById,
  );

  router.post(
    '/:id/override',
    deps.auth.authenticateFresh,
    requireAdmin,
    validate({ params: idParamSchema, body: OverrideDecisionSchema }),
    deps.controller.override,
  );

  return router;
}

/**
 * Audit routes — ADMIN only, and read-only by construction.
 *
 * There is no POST, PATCH or DELETE here and there never will be. Immutability is enforced
 * in three independent places: the absence of any mutating route, the absence of any
 * mutating method on `AuditService`, and a hard deny in the Firestore security rules.
 */
export function buildAuditRouter(deps: {
  controller: AuditController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();

  router.get(
    '/timeline/:targetId',
    deps.auth.authenticate,
    requireAdmin,
    validate({ params: z.object({ targetId: z.string().trim().min(1).max(128) }) }),
    deps.controller.timeline,
  );

  router.get(
    '/',
    deps.auth.authenticate,
    requireAdmin,
    validate({ query: paginationQuerySchema.merge(AuditLogQuerySchema) }),
    deps.controller.list,
  );

  router.get(
    '/:id',
    deps.auth.authenticate,
    requireAdmin,
    validate({ params: idParamSchema }),
    deps.controller.getById,
  );

  return router;
}

/** Notification routes — every user sees only their own and the broadcasts for their role. */
export function buildNotificationRouter(deps: {
  controller: AuditController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();

  router.get('/unread-count', deps.auth.authenticate, deps.controller.unreadCount);

  router.get(
    '/',
    deps.auth.authenticate,
    validate({ query: paginationQuerySchema.merge(NotificationQuerySchema) }),
    deps.controller.listNotifications,
  );

  router.post(
    '/read',
    deps.auth.authenticate,
    validate({ body: MarkReadSchema }),
    deps.controller.markRead,
  );

  return router;
}
