import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '@/config/env';
import { ErrorCode } from '@/constants/errorCodes';
import { AppError, NotFoundError, ValidationError, toAppError } from '@/utils/errors';
import type { ApiFailure } from '@/types/common';
import { createLogger } from '@/utils/logger';

const log = createLogger('http-error');

/**
 * Terminal error middleware. Exactly one place in the process converts a thrown value into
 * an HTTP response, which is what makes the error contract enforceable.
 *
 * Rules:
 *  - Operational errors (4xx) log at `warn` without a stack: they are expected traffic.
 *  - Non-operational errors (5xx) log at `error` with the full stack and cause chain.
 *  - Production responses never include a stack trace or an internal message for 5xx.
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Delegating to Express's default handler is the only correct move once headers are out.
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = normalise(err);
  const correlationId = req.correlationId ?? 'unknown';

  const logPayload = {
    correlationId,
    method: req.method,
    path: req.originalUrl,
    statusCode: appError.statusCode,
    code: appError.code,
    userId: req.principal?.userId,
  };

  if (appError.isOperational && appError.statusCode < 500) {
    log.warn({ ...logPayload, details: appError.details }, appError.message);
  } else {
    log.error({ ...logPayload, err: appError, cause: (appError as { cause?: unknown }).cause }, appError.message);
  }

  const exposeInternals = !env.isProduction;
  const isServerError = appError.statusCode >= 500;

  const body: ApiFailure = {
    success: false,
    error: {
      code: appError.code,
      message:
        isServerError && !exposeInternals
          ? 'An internal error occurred. Quote the correlation id when reporting this.'
          : appError.message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
      correlationId,
      timestamp: new Date().toISOString(),
    },
  };

  if (exposeInternals && isServerError && err instanceof Error && err.stack) {
    (body.error as Record<string, unknown>).stack = err.stack.split('\n').slice(0, 12);
  }

  res.status(appError.statusCode).json(body);
};

/**
 * Convert framework- and library-specific errors into the domain taxonomy.
 * Kept separate from `toAppError` so the pure utils module stays free of Express/Zod.
 */
function normalise(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new ValidationError('Request validation failed', formatZodIssues(err));
  }

  if (isSyntaxError(err)) {
    return new AppError('Request body is not valid JSON', 400, ErrorCode.MALFORMED_REQUEST);
  }

  if (isPayloadTooLarge(err)) {
    return new AppError('Request body exceeds the maximum permitted size', 413, ErrorCode.MALFORMED_REQUEST);
  }

  if (isGoogleUnavailable(err)) {
    return new AppError('The datastore is temporarily unavailable', 503, ErrorCode.DATASTORE_UNAVAILABLE, {
      isOperational: false,
      cause: err,
    });
  }

  return toAppError(err);
}

export function formatZodIssues(error: ZodError): { field: string; message: string; code: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

function isSyntaxError(err: unknown): boolean {
  return err instanceof SyntaxError && 'body' in (err as object);
}

function isPayloadTooLarge(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large';
}

/** google-gax surfaces transport failures as numeric gRPC status codes. 14 = UNAVAILABLE. */
function isGoogleUnavailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 14 || code === 4 || code === 'UNAVAILABLE';
}

/** Registered after all routers: anything reaching here matched no route. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError('Endpoint', `${req.method} ${req.originalUrl}`));
}
