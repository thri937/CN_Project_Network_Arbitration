import type { NextFunction, Request, Response } from 'express';
import { generateCorrelationId } from '@/utils/ids';

const CORRELATION_HEADER = 'x-correlation-id';
/** Accept an upstream trace id so a request can be followed across the whole platform. */
const ALT_HEADERS = ['x-request-id', 'x-amzn-trace-id'] as const;

/** RFC-ish sanity check: keep it printable, bounded, and free of header-injection chars. */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Assigns a correlation id and a start timestamp to every request.
 *
 * Must be registered before any middleware that logs or throws, because both the HTTP
 * logger and the error handler read `req.correlationId`.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound =
    firstSafeHeader(req, CORRELATION_HEADER) ??
    ALT_HEADERS.map((h) => firstSafeHeader(req, h)).find(Boolean);

  req.correlationId = inbound ?? generateCorrelationId();
  req.startedAt = Date.now();

  // Echo it back so operators can copy the id straight out of the browser's network tab.
  res.setHeader(CORRELATION_HEADER, req.correlationId);
  next();
}

function firstSafeHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}
