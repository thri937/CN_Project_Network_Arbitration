import type { Request, Response } from 'express';
import type { PaginationQuery } from '@/models/base.model';
import type {
  CreatePolicyPayload,
  PolicyStatus,
  UpdatePolicyPayload,
} from '@/models/policy.model';
import { requireActor } from '@/middleware/authenticate';
import type { PolicyService } from '@/services/policy.service';
import { asyncHandler } from '@/utils/asyncHandler';
import { created, noContent, ok, paginated } from '@/utils/http';

/**
 * Business policy endpoints.
 *
 * `GET /policies/effective` is the important one operationally. It returns the FULLY
 * RESOLVED policy — every override merged over the defaults, with compliance ceilings
 * already clamped. It is the exact object the arbitration engine consumes, so an operator
 * asking "what rules are actually in force right now?" gets the engine's own answer rather
 * than a reconstruction that might disagree with it.
 */
export function createPolicyController(deps: { policies: PolicyService }) {
  return {
    /** GET /policies */
    list: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as PaginationQuery & { status?: PolicyStatus };
      const page = await deps.policies.list(query.status, {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      paginated(req, res, page, query.limit);
    }),

    /** GET /policies/active — the governing policy document. */
    active: asyncHandler(async (req: Request, res: Response) => {
      ok(req, res, await deps.policies.getActive());
    }),

    /** GET /policies/effective — the resolved configuration the engine consumes. */
    effective: asyncHandler(async (req: Request, res: Response) => {
      ok(req, res, await deps.policies.explainActive());
    }),

    /** GET /policies/:id */
    getById: asyncHandler(async (req: Request, res: Response) => {
      ok(req, res, await deps.policies.getById(req.params.id as string));
    }),

    /** POST /policies — creates a DRAFT; governs nothing until activated. */
    create: asyncHandler(async (req: Request, res: Response) => {
      const policy = await deps.policies.create(req.body as CreatePolicyPayload, requireActor(req));
      created(req, res, policy, `/policies/${policy.id}`);
    }),

    /**
     * PATCH /policies/:id
     * Editing a DRAFT updates it. Editing the ACTIVE policy forks a new draft revision and
     * leaves the current rules untouched — the response is the new draft.
     */
    update: asyncHandler(async (req: Request, res: Response) => {
      const policy = await deps.policies.update(
        req.params.id as string,
        req.body as UpdatePolicyPayload,
        requireActor(req),
      );
      ok(req, res, policy);
    }),

    /** POST /policies/:id/activate — atomically archives the previous active policy. */
    activate: asyncHandler(async (req: Request, res: Response) => {
      const policy = await deps.policies.activate(req.params.id as string, requireActor(req));
      ok(req, res, policy);
    }),

    /** DELETE /policies/:id — drafts only. */
    remove: asyncHandler(async (req: Request, res: Response) => {
      await deps.policies.deleteDraft(req.params.id as string, requireActor(req));
      noContent(res);
    }),
  };
}

export type PolicyController = ReturnType<typeof createPolicyController>;
