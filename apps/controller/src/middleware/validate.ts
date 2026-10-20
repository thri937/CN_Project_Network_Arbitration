import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { ValidationError } from '@/utils/errors';
import { formatZodIssues } from './errorHandler';

/**
 * Schema-driven request validation.
 *
 * The parsed (and therefore coerced, defaulted and stripped) result replaces the raw
 * value on the request. Downstream controllers consume typed, trusted data — they never
 * touch `req.body` before validation, and there is no second place where defaults are
 * applied.
 *
 * Note the ordering: params → query → body. Validating the cheapest, most-likely-wrong
 * inputs first means a malformed id short-circuits before we parse a large body.
 */
export interface RequestSchemas {
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  body?: ZodTypeAny;
}

export function validate(schemas: RequestSchemas): RequestHandler {
  return function validateRequest(req: Request, _res: Response, next: NextFunction): void {
    try {
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as Request['params'];
      }
      if (schemas.query) {
        // Express 4 exposes `query` as a writable own property; Express 5 makes it a
        // getter. Defining the property works under both.
        const parsedQuery = schemas.query.parse(req.query) as Request['query'];
        Object.defineProperty(req, 'query', {
          value: parsedQuery,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new ValidationError('Request validation failed', formatZodIssues(error)));
        return;
      }
      next(error);
    }
  };
}

/** Typed accessor so controllers get inference from the schema they declared. */
export type Validated<S extends RequestSchemas> = {
  params: S['params'] extends ZodTypeAny ? z.infer<S['params']> : Request['params'];
  query: S['query'] extends ZodTypeAny ? z.infer<S['query']> : Request['query'];
  body: S['body'] extends ZodTypeAny ? z.infer<S['body']> : unknown;
};
