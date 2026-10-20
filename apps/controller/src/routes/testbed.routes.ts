import { Router } from 'express';
import { UserRole } from '@/constants/enums';
import type { AuthMiddleware } from '@/middleware/authenticate';
import { requireMinRole } from '@/middleware/authorize';
import type { createTestbedController } from '@/controllers/testbed.controller';

/**
 * /api/v1/testbed — the real-network testbed.
 *
 *   GET    /status                       VIEWER   gateway link, capacity, LAN addresses, recording
 *   GET    /devices                      VIEWER   devices joined to slices
 *   GET    /recording.csv                VIEWER   this session's measurements
 *   DELETE /devices/:id                  MANAGER  remove a device from its slice
 *   POST   /slices/:id/join-code/rotate  MANAGER
 *   POST   /slices/:id/demand            MANAGER  operator remote control of a slice's devices
 *   POST   /scenarios/:name/run          MANAGER  IDLE, TC1–TC5 demand patterns
 *   PUT    /arbitration                  MANAGER  automatic arbitration on/off (A/B test)
 */
export function buildTestbedRouter(deps: {
  controller: ReturnType<typeof createTestbedController>;
  auth: AuthMiddleware;
}): Router {
  const router = Router();
  router.use(deps.auth.authenticate);

  router.get('/status', deps.controller.status);
  router.get('/devices', deps.controller.devices);
  router.get('/recording.csv', deps.controller.downloadRecording);

  router.delete('/devices/:id', requireMinRole(UserRole.MANAGER), deps.controller.unbindDevice);
  router.post('/slices/:id/join-code/rotate', requireMinRole(UserRole.MANAGER), deps.controller.rotateJoinCode);
  router.post('/slices/:id/demand', requireMinRole(UserRole.MANAGER), deps.controller.setSliceDemand);
  router.post('/scenarios/:name/run', requireMinRole(UserRole.MANAGER), deps.controller.runScenario);
  router.put('/arbitration', requireMinRole(UserRole.MANAGER), deps.controller.setArbitration);

  return router;
}
