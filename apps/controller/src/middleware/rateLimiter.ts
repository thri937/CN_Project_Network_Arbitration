import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { env } from '@/config/env';
import { ErrorCode } from '@/constants/errorCodes';
import type { ApiFailure } from '@/types/common';
import { normaliseClientIp } from '@/utils/net';

/**
 * Rate limiting.
 *
 * Two tiers, because the threat models differ:
 *
 *  - `apiLimiter` protects the general API from a runaway client. It is keyed by
 *    authenticated user id when available, falling back to IP. Keying by user matters
 *    because an entire enterprise NOC may sit behind one egress IP; per-IP-only limiting
 *    would let one operator's misbehaving tab throttle the whole operations team.
 *
 *  - `authLimiter` protects credential endpoints from brute force and is deliberately
 *    keyed by IP only (an attacker controls the claimed user id, not their source
 *    address) and is far stricter.
 *
 * The dashboard polls telemetry frequently, so limits are generous by default and tunable
 * via `RATE_LIMIT_MAX`. In production behind a proxy, `TRUST_PROXY` must be enabled or
 * every request will appear to originate from the load balancer.
 */

function limitExceededBody(req: Request): ApiFailure {
  return {
    success: false,
    error: {
      code: ErrorCode.RATE_LIMITED,
      message: 'Too many requests. Slow down and retry shortly.',
      correlationId: req.correlationId ?? 'unknown',
      timestamp: new Date().toISOString(),
    },
  };
}

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // `handler` (not `message`) so the failure body matches the platform error envelope.
  handler: (req, res, _next, options) => {
    res.status(options.statusCode).json(limitExceededBody(req));
  },
  // `normaliseClientIp` deliberately accepts `undefined` (returning a shared `unknown`
  // bucket) and performs its own IPv6 /64 truncation, so the library's advisory warning
  // about a missing `req.ip` would be noise. Every other validation stays enabled.
  validate: { ip: false },
};

export const apiLimiter: RequestHandler = rateLimit({
  ...shared,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  // Prefer the authenticated user id; fall back to a /64-normalised source address.
  keyGenerator: (req) => req.principal?.userId ?? `ip:${normaliseClientIp(req.ip)}`,
  skip: () => env.isTest,
});

export const authLimiter: RequestHandler = rateLimit({
  ...shared,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => `ip:${normaliseClientIp(req.ip)}`,
  skipSuccessfulRequests: true,
  skip: () => env.isTest,
});
