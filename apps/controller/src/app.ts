import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import cors, { type CorsOptions } from 'cors';
import compression from 'compression';
import { env } from '@/config/env';
import type { HealthRegistry } from '@/config/health';
import { createHealthController } from '@/controllers/health.controller';
import { buildHealthRouter } from '@/routes/health.routes';
import { errorHandler, notFoundHandler } from '@/middleware/errorHandler';
import { httpLogger } from '@/middleware/httpLogger';
import { apiLimiter } from '@/middleware/rateLimiter';
import { requestContext } from '@/middleware/requestContext';
import { ForbiddenError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';

const log = createLogger('app');

export interface AppOptions {
  health: HealthRegistry;
  startedAt: number;
  /** The fully-wired versioned API router, built by `routes/index.ts` from the container. */
  apiRouter: Router;
  /** Optional extra mounts (Swagger UI, metrics) added before the 404 handler. */
  extraMounts?: { path: string; router: Router }[];
}

/**
 * Builds the Express application.
 *
 * Kept free of `listen()` and of any process-level concern so that Supertest can exercise
 * the full middleware stack in-process, with no port binding and no background jobs.
 *
 * MIDDLEWARE ORDER IS LOAD-BEARING — do not reorder without reading this:
 *   1. trust proxy      — must precede anything reading `req.ip` (rate limiter, logs)
 *   2. helmet           — set security headers before any handler can respond
 *   3. requestContext   — correlation id must exist before the logger or error handler
 *   4. httpLogger       — logs need the correlation id from step 3
 *   5. cors             — reject cross-origin before spending cycles parsing a body
 *   6. body parsers     — bounded by BODY_LIMIT
 *   7. compression      — wraps the response stream of everything below
 *   8. health routes    — unauthenticated, unrate-limited, outside the API prefix
 *   9. rate limiter     — applies to the API surface only
 *  10. api router
 *  11. 404 → error handler (terminal)
 */
export function createApp(options: AppOptions): Express {
  const app = express();

  // 1. Behind Render/Railway/Firebase Hosting the client IP arrives in X-Forwarded-For.
  //    `1` (trust exactly one hop) rather than `true`, so a client cannot spoof its IP by
  //    injecting its own X-Forwarded-For header.
  app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
  app.disable('x-powered-by');
  app.set('etag', false); // Telemetry responses change every tick; ETags only add work.

  // 2. Security headers. CSP is disabled here because this process serves JSON and the
  //    Swagger UI only; the SPA is served by Firebase Hosting, which owns its own CSP.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  // 3 & 4.
  app.use(requestContext);
  app.use(httpLogger);

  // 5. Strict allow-list CORS. A rejected origin produces a 403 through the normal error
  //    envelope rather than an opaque browser-side failure, which makes misconfiguration
  //    diagnosable from the server logs.
  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      // Same-origin requests, curl, and server-to-server calls send no Origin header.
      if (!origin) return callback(null, true);
      if (env.CORS_ORIGINS.includes(origin) || env.CORS_ORIGINS.includes('*')) {
        return callback(null, true);
      }
      log.warn({ origin }, 'blocked cross-origin request');
      return callback(new ForbiddenError(`Origin '${origin}' is not permitted`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
    exposedHeaders: ['X-Correlation-Id', 'RateLimit-Remaining', 'RateLimit-Reset'],
    maxAge: 86_400,
  };
  app.use(cors(corsOptions));

  // 6.
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));

  // 7.
  app.use(compression());

  // 8.
  const healthController = createHealthController({
    health: options.health,
    startedAt: options.startedAt,
  });
  app.use('/health', buildHealthRouter(healthController));

  // 9 & 10.
  app.use(env.API_PREFIX, apiLimiter, options.apiRouter);

  for (const mount of options.extraMounts ?? []) {
    app.use(mount.path, mount.router);
  }

  // 11.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
