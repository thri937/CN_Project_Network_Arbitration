import type { ActorContext } from './common';
import type { AuthenticatedPrincipal } from '@/interfaces/auth.port';

/**
 * Express request augmentation.
 *
 * `req.principal` is populated by `middleware/authenticate.ts` and is the ONLY place
 * identity may be read from. Controllers must never re-parse the Authorization header.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present on every request; assigned by `middleware/requestContext.ts`. */
      correlationId: string;
      /** Epoch ms at which the request entered the pipeline. */
      startedAt: number;
      /** Present only after `authenticate` has run. */
      principal?: AuthenticatedPrincipal;
      /** Derived from `principal`; convenience for services that write audit records. */
      actor?: ActorContext;
    }
  }
}

export {};
