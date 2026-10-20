import pinoHttp from 'pino-http';
import type { RequestHandler } from 'express';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';

/**
 * HTTP access logging.
 *
 * Health checks and the telemetry polling endpoint are demoted to `trace`: at a two-second
 * dashboard poll interval they would otherwise account for well over 90 % of log volume
 * and bury the lines an operator actually needs during an incident.
 */
const QUIET_PATHS = ['/health', '/health/ready', '/health/live', '/favicon.ico'];

export const httpLogger: RequestHandler = pinoHttp({
  logger,
  genReqId: (req) => (req as { correlationId?: string }).correlationId ?? 'unknown',
  quietReqLogger: true,
  autoLogging: {
    ignore: (req) => env.isTest || QUIET_PATHS.some((p) => req.url?.startsWith(p)),
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} → ${res.statusCode} (${err.message})`,
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, id: req.id }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
