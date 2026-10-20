import { Router } from 'express';
import type { HealthController } from '@/controllers/health.controller';

/**
 * Health routes are mounted OUTSIDE the versioned API prefix and are deliberately
 * unauthenticated: an orchestrator probe cannot present a bearer token, and gating
 * liveness behind auth is a classic way to make an outage unrecoverable.
 *
 * `/info` exposes no secrets — only adapter names and numeric capacity configuration.
 */
export function buildHealthRouter(controller: HealthController): Router {
  const router = Router();

  router.get('/', controller.live);
  router.get('/live', controller.live);
  router.get('/ready', controller.ready);
  router.get('/info', controller.info);

  return router;
}
