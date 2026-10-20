import type { Request, Response } from 'express';
import { env, OFFERED_CAPACITY_MBPS } from '@/config/env';
import type { HealthRegistry } from '@/config/health';
import { ok, send } from '@/utils/http';
import { asyncHandler } from '@/utils/asyncHandler';

/**
 * Operational endpoints.
 *
 * `/live`    — process is running. Never touches a dependency; used as the container
 *              liveness probe. If this fails, restart the process.
 * `/ready`   — every registered dependency is usable. Used as the load-balancer readiness
 *              probe. Returns 503 when not ready so traffic is withheld rather than
 *              failing in the user's face.
 * `/info`    — build and wiring metadata. Shown on Settings → System, and invaluable when
 *              diagnosing "why is it not using Firestore" in a deployed environment.
 */
export function createHealthController(deps: { health: HealthRegistry; startedAt: number }) {
  return {
    live: (req: Request, res: Response): void => {
      ok(req, res, { status: 'up', uptimeSeconds: Math.floor(process.uptime()) });
    },

    ready: asyncHandler(async (req: Request, res: Response) => {
      const report = await deps.health.check();
      send(req, res, report.status === 'down' ? 503 : 200, report);
    }),

    info: (req: Request, res: Response): void => {
      ok(req, res, {
        service: 'sentinel-arbitration-backend',
        version: process.env.npm_package_version ?? '1.0.0',
        environment: env.NODE_ENV,
        node: process.version,
        startedAt: new Date(deps.startedAt).toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        // The active adapter set — this is the hexagonal wiring, made observable.
        adapters: {
          datastore: env.DATASTORE_DRIVER,
          auth: env.AUTH_DRIVER,
          telemetry: env.TELEMETRY_PROVIDER,
        },
        network: {
          totalCapacityMbps: env.NETWORK_TOTAL_CAPACITY_MBPS,
          reservedCapacityMbps: env.NETWORK_RESERVED_CAPACITY_MBPS,
          offeredCapacityMbps: OFFERED_CAPACITY_MBPS,
        },
        jobs: {
          enabled: env.ENABLE_JOBS,
          telemetryTickMs: env.TELEMETRY_TICK_MS,
          autoArbitration: env.AUTO_ARBITRATION,
        },
      });
    },
  };
}

export type HealthController = ReturnType<typeof createHealthController>;
