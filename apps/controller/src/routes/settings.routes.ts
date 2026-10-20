import { Router } from 'express';
import { z } from 'zod';
import type { SettingsController } from '@/controllers/settings.controller';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { requireAdmin } from '@/middleware/authorize';
import { validate } from '@/middleware/validate';
import { UpdateSettingsSchema } from '@/models/settings.model';

/**
 * Settings and reports.
 *
 *   GET   /settings          VIEWER
 *   GET   /settings/system   VIEWER
 *   PATCH /settings          ADMIN + fresh session
 *   GET   /reports/overview  VIEWER
 *
 * Settings reads are open because the dashboard needs the theme, currency and poll interval
 * before it can render anything. Writes are ADMIN-only with a revalidated session, since
 * `autoArbitrationEnabled` and `maintenanceMode` control whether the platform acts on
 * contention at all — the single most consequential operational switch it has.
 */
export function buildSettingsRouter(deps: {
  controller: SettingsController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();

  router.get('/system', deps.auth.authenticate, deps.controller.system);
  router.get('/', deps.auth.authenticate, deps.controller.get);

  router.patch(
    '/',
    deps.auth.authenticateFresh,
    requireAdmin,
    validate({ body: UpdateSettingsSchema }),
    deps.controller.update,
  );

  return router;
}

export function buildReportRouter(deps: {
  controller: SettingsController;
  auth: AuthMiddleware;
}): Router {
  const router = Router();

  const rangeQuery = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  });

  router.get(
    '/overview',
    deps.auth.authenticate,
    validate({ query: rangeQuery }),
    deps.controller.reportOverview,
  );

  return router;
}
