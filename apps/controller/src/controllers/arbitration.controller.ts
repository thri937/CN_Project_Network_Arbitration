import type { Request, Response } from 'express';
import { ArbitrationOutcome, ArbitrationTrigger } from '@/constants/enums';
import { requireActor, requirePrincipal } from '@/middleware/authenticate';
import type { PaginationQuery } from '@/models/base.model';
import type {
  OverrideDecisionPayload,
  TriggerArbitrationPayload,
} from '@/models/arbitrationDecision.model';
import type { ArbitrationService } from '@/services/arbitration.service';
import type { ContentionService } from '@/services/contention.service';
import { asyncHandler } from '@/utils/asyncHandler';
import { ConflictError } from '@/utils/errors';
import { ErrorCode } from '@/constants/errorCodes';
import { ok, paginated } from '@/utils/http';

/**
 * Arbitration endpoints.
 *
 * `POST /arbitration/simulate` is the one operators use most. It computes a plan WITHOUT
 * applying it, so the question "what would this system do to my network right now?" is
 * answerable at any moment. An automated control loop nobody can interrogate is one that
 * gets switched off after its first surprising decision.
 */
export function createArbitrationController(deps: {
  arbitration: ArbitrationService;
  contention: ContentionService;
}) {
  return {
    /** GET /arbitration — paginated decision history. */
    list: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as PaginationQuery & {
        contentionId?: string;
        outcome?: ArbitrationOutcome;
        trigger?: ArbitrationTrigger;
        from?: string;
        to?: string;
      };

      const page = await deps.arbitration.list(
        {
          ...(query.contentionId ? { contentionId: query.contentionId } : {}),
          ...(query.outcome ? { outcome: query.outcome } : {}),
          ...(query.trigger ? { trigger: query.trigger } : {}),
          ...(query.from ? { fromMs: Date.parse(query.from) } : {}),
          ...(query.to ? { toMs: Date.parse(query.to) } : {}),
        },
        { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
      );

      paginated(req, res, page, query.limit);
    }),

    /** GET /arbitration/recent — the live feed on the dashboard. */
    recent: asyncHandler(async (req: Request, res: Response) => {
      ok(req, res, await deps.arbitration.recent(20));
    }),

    /**
     * GET /arbitration/summary — outcome roll-up for Reports.
     *
     * Range defaults are deliberately NOT computed here: the service owns them, because it
     * holds the injected clock. Defaulting from `Date.now()` in the controller silently
     * excludes decisions whenever the two clocks differ.
     */
    summary: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as { from?: string; to?: string };

      ok(
        req,
        res,
        await deps.arbitration.summarise({
          ...(query.from ? { fromMs: Date.parse(query.from) } : {}),
          ...(query.to ? { toMs: Date.parse(query.to) } : {}),
        }),
      );
    }),

    /** GET /arbitration/:id — the full, self-contained decision record. */
    getById: asyncHandler(async (req: Request, res: Response) => {
      ok(req, res, await deps.arbitration.getById(req.params.id as string));
    }),

    /**
     * POST /arbitration/simulate — compute a plan without applying it.
     *
     * MANAGER and above: it reads live telemetry and the governing policy, and reveals
     * every department's business score. That is not information for a public wall display.
     */
    simulate: asyncHandler(async (req: Request, res: Response) => {
      const plan = await deps.arbitration.simulate(requireActor(req));
      ok(req, res, { plan, applied: false });
    }),

    /**
     * POST /arbitration/trigger — run arbitration against the open contention now.
     *
     * Bypasses the automatic cadence but NOT the safety gates: the cooldown and in-flight
     * checks still apply, because a human clicking twice must not compound degradations any
     * more than a runaway scheduler may.
     */
    trigger: asyncHandler(async (req: Request, res: Response) => {
      const payload = req.body as TriggerArbitrationPayload;
      const event = deps.contention.getOpenEvent();

      if (!event) {
        throw new ConflictError(
          'There is no open contention to arbitrate. Use /arbitration/simulate to see what would ' +
            'happen if the network were contended.',
          ErrorCode.CONFLICT,
        );
      }

      const result = await deps.arbitration.run(event, {
        trigger: ArbitrationTrigger.MANUAL,
        actor: requireActor(req),
        dryRun: payload.dryRun,
      });

      ok(req, res, {
        plan: result.plan,
        decision: result.decision,
        applied: result.decision !== null,
      });
    }),

    /** POST /arbitration/:id/override — ADMIN; requires a recorded reason. */
    override: asyncHandler(async (req: Request, res: Response) => {
      const payload = req.body as OverrideDecisionPayload;
      const decision = await deps.arbitration.override(
        req.params.id as string,
        payload,
        requireActor(req),
      );
      ok(req, res, decision);
    }),

    /** GET /arbitration/contention/:contentionId — every pass for one contention. */
    forContention: asyncHandler(async (req: Request, res: Response) => {
      requirePrincipal(req);
      ok(req, res, await deps.arbitration.forContention(req.params.contentionId as string));
    }),
  };
}

export type ArbitrationController = ReturnType<typeof createArbitrationController>;
