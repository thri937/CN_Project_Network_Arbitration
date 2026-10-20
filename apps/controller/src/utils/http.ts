import type { Request, Response } from 'express';
import type { ApiSuccess, Page, PageMeta, ResponseMeta } from '@/types/common';

/**
 * Response helpers.
 *
 * Controllers never call `res.json` directly — they call these, which guarantees every
 * successful payload is wrapped in the `ApiSuccess` envelope with correlation metadata
 * attached. This is what lets the frontend unwrap responses in one interceptor.
 */

function baseMeta(req: Request, extra?: ResponseMeta): ResponseMeta {
  return {
    correlationId: req.correlationId,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - req.startedAt,
    ...extra,
  };
}

export function send<T>(req: Request, res: Response, status: number, data: T, meta?: ResponseMeta): void {
  const body: ApiSuccess<T> = { success: true, data, meta: baseMeta(req, meta) };
  res.status(status).json(body);
}

export function ok<T>(req: Request, res: Response, data: T, meta?: ResponseMeta): void {
  send(req, res, 200, data, meta);
}

export function created<T>(req: Request, res: Response, data: T, location?: string): void {
  if (location) res.setHeader('Location', location);
  send(req, res, 201, data);
}

export function accepted<T>(req: Request, res: Response, data: T): void {
  send(req, res, 202, data);
}

export function noContent(res: Response): void {
  res.status(204).end();
}

/** Emit a `Page<T>` as a data array plus `meta.page` pagination descriptors. */
export function paginated<T>(
  req: Request,
  res: Response,
  page: Page<T>,
  limit: number,
  extra?: ResponseMeta,
): void {
  const pageMeta: PageMeta = {
    limit,
    returned: page.items.length,
    nextCursor: page.nextCursor,
    ...(page.total !== undefined ? { total: page.total } : {}),
  };
  send(req, res, 200, page.items, { ...extra, page: pageMeta });
}
