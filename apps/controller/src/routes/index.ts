import { Router } from 'express';
import type { AppContainer } from '@/bootstrap';
import { env } from '@/config/env';
import { ok } from '@/utils/http';
import {
  buildArbitrationRouter,
  buildAuditRouter,
  buildNotificationRouter,
} from './arbitration.routes';
import { buildAuthRouter } from './auth.routes';
import { buildCapacityRouter, buildContentionRouter } from './capacity.routes';
import { buildDepartmentRouter } from './department.routes';
import { buildPolicyRouter } from './policy.routes';
import { buildReportRouter, buildSettingsRouter } from './settings.routes';
import { buildSliceRouter } from './slice.routes';
import { buildTelemetryRouter } from './telemetry.routes';
import { buildUserRouter } from './user.routes';
import { buildTestbedRouter } from './testbed.routes';

/**
 * API router assembly.
 *
 * Every feature module contributes exactly one router here. Keeping the mount table in a
 * single file means the entire public surface of the service is auditable at a glance —
 * which matters when a security review asks "what is reachable without authentication?".
 *
 * Mount order is significant only where paths overlap; they deliberately do not.
 */
export function buildApiRouter(container: AppContainer): Router {
  const router = Router();

  const resources = [
    'auth',
    'users',
    'departments',
    'policies',
    'slices',
    'telemetry',
    'capacity',
    'contention',
    'arbitration',
    'audit',
    'notifications',
    'settings',
    'reports',
    'testbed',
  ];

  /** Service discovery document — lets the SPA verify it is talking to a compatible API. */
  router.get('/', (req, res) => {
    ok(req, res, {
      name: 'Runtime Arbitration for Contended, SLA-Critical Enterprise Network Slices',
      apiVersion: 'v1',
      prefix: env.API_PREFIX,
      documentation: env.SWAGGER_ENABLED ? env.SWAGGER_PATH : null,
      resources,
    });
  });

  router.use(
    '/auth',
    buildAuthRouter({
      controller: container.controllers.auth,
      auth: container.middleware.auth,
      authService: container.services.auth,
    }),
  );

  router.use(
    '/users',
    buildUserRouter({
      controller: container.controllers.users,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/departments',
    buildDepartmentRouter({
      controller: container.controllers.departments,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/policies',
    buildPolicyRouter({
      controller: container.controllers.policies,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/slices',
    buildSliceRouter({
      controller: container.controllers.slices,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/telemetry',
    buildTelemetryRouter({
      controller: container.controllers.telemetry,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/capacity',
    buildCapacityRouter({
      controller: container.controllers.capacity,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/contention',
    buildContentionRouter({
      controller: container.controllers.contention,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/arbitration',
    buildArbitrationRouter({
      controller: container.controllers.arbitration,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/audit',
    buildAuditRouter({
      controller: container.controllers.audit,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/notifications',
    buildNotificationRouter({
      controller: container.controllers.audit,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/settings',
    buildSettingsRouter({
      controller: container.controllers.settings,
      auth: container.middleware.auth,
    }),
  );

  router.use(
    '/reports',
    buildReportRouter({
      controller: container.controllers.settings,
      auth: container.middleware.auth,
    }),
  );


  router.use(
    '/testbed',
    buildTestbedRouter({
      controller: (container.controllers as any).testbed,
      auth: container.middleware.auth,
    }),
  );

  return router;
}
