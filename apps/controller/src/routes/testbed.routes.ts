import { Router } from 'express';
import { UserRole } from '@/constants/enums';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { requireMinRole } from '@/middleware/authorize';
import type { createTestbedController } from '@/controllers/testbed.controller';

export function buildTestbedRouter(deps: {
  controller: ReturnType<typeof createTestbedController>;
  auth: AuthMiddleware;
}): Router {
  const router = Router();

  // Public / VIEWER endpoints
  router.get('/status', deps.controller.status);
  router.get('/devices', deps.controller.devices);
  router.get('/experiments/:id/download', deps.controller.downloadExperimentCsv);

  // Protected MANAGER+ endpoints
  router.use(deps.auth.authenticate);

  router.delete(
    '/devices/:id',
    requireMinRole(UserRole.MANAGER),
    deps.controller.unbindDevice
  );

  router.post(
    '/slices/:id/join-code/rotate',
    requireMinRole(UserRole.MANAGER),
    deps.controller.rotateJoinCode
  );

  router.post(
    '/slices/:id/demand',
    requireMinRole(UserRole.MANAGER),
    deps.controller.setSliceDemand
  );

  router.post(
    '/scenarios/:name/run',
    requireMinRole(UserRole.MANAGER),
    deps.controller.runScenario
  );

  router.put(
    '/arbitration',
    requireMinRole(UserRole.MANAGER),
    deps.controller.setArbitration
  );

  router.post(
    '/experiments',
    requireMinRole(UserRole.MANAGER),
    deps.controller.startExperiment
  );

  router.post(
    '/experiments/:id/stop',
    requireMinRole(UserRole.MANAGER),
    deps.controller.stopExperiment
  );

  return router;
}
