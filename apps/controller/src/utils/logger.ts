import pino, { type Logger, type LoggerOptions } from 'pino';
import { env } from '@/config/env';

/**
 * Structured logging.
 *
 * Production emits newline-delimited JSON so Render/Railway/Cloud Logging can index it.
 * Development pipes through pino-pretty for readability. Redaction is applied at the
 * logger level so a careless `log.info({ req })` can never leak a bearer token.
 */

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'idToken',
  'accessToken',
  'refreshToken',
  '*.password',
  '*.idToken',
  '*.accessToken',
  '*.refreshToken',
  'privateKey',
  'FIREBASE_PRIVATE_KEY',
  'JWT_SECRET',
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'arbitration-backend', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
};

const usePretty = env.LOG_PRETTY && !env.isProduction && env.LOG_LEVEL !== 'silent';

export const logger: Logger = usePretty
  ? pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service,env',
          messageFormat: '{if module}[{module}] {end}{msg}',
        },
      },
    })
  : pino(options);

/**
 * Create a child logger bound to a module name. Every service, job and adapter should
 * own one so that log lines are attributable without repeating context on every call.
 *
 * @example const log = createLogger('arbitration-engine');
 */
export function createLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ module, ...bindings });
}
