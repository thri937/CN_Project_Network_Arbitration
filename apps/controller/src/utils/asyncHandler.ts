import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not forward rejected promises from async handlers to the error
 * middleware — an unhandled rejection would otherwise hang the request until the client
 * times out. Every async route handler is wrapped in this.
 *
 * (Express 5 does this natively. The wrapper is kept so the codebase is version-agnostic
 * and so the intent is explicit at every call site.)
 */
export function asyncHandler<
  Req extends Request = Request,
  Res extends Response = Response,
>(fn: (req: Req, res: Res, next: NextFunction) => Promise<unknown> | unknown): RequestHandler {
  return function wrapped(req, res, next): void {
    Promise.resolve(fn(req as Req, res as Res, next)).catch(next);
  };
}
