import type { Request, Response } from 'express';
import type { ContentionSeverity, ContentionStatus } from '@/constants/enums';
import { ContentionTunables } from '@/constants/tunables';
import type { PaginationQuery } from '@/models/base.model';
import type { ContentionService } from '@/services/contention.service';
import { asyncHandler } from '@/utils/asyncHandler';
import { ok, paginated } from '@/utils/http';

/**
 * Contention event endpoints.
 *
 * `/contention/current` returns the open event together with the detector's own tuning, so
 * an operator asking "why hasn't this triggered arbitration yet?" gets the answer — the
 * cooldown state and the thresholds — rather than having to read the source.
 */
export function createContentionController(deps: { contention: ContentionService }) {
  return {
    /** GET /contention/current — the open contention, if any. */
    current: asyncHandler(async (req: Request, res: Response) => {
      const event = deps.contention.getOpenEvent();

      ok(req, res, {
        event,
        open: event !== null,
        // Surfacing the gate makes "why no arbitration?" answerable from the UI.
        arbitration: event ? deps.contention.canArbitrate(event) : null,
        detector: {
          detectionThresholdRatio: ContentionTunables.DETECTION_THRESHOLD_RATIO,
          confirmationSamples: ContentionTunables.CONFIRMATION_SAMPLES,
          clearanceSamples: ContentionTunables.CLEARANCE_SAMPLES,
          arbitrationCooldownSeconds: ContentionTunables.ARBITRATION_COOLDOWN_SECONDS,
        },
      });
    }),

    /** GET /contention — paginated history. */
    list: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as PaginationQuery & {
        status?: ContentionStatus;
        severity?: ContentionSeverity;
        from?: string;
        to?: string;
      };

      const page = await deps.contention.list(
        {
          ...(query.status ? { status: query.status } : {}),
          ...(query.severity ? { severity: query.severity } : {}),
          ...(query.from ? { fromMs: Date.parse(query.from) } : {}),
          ...(query.to ? { toMs: Date.parse(query.to) } : {}),
        },
        { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
      );

      paginated(req, res, page, query.limit);
    }),

    /** GET /contention/:id */
    getById: asyncHandler(async (req: Request, res: Response) => {
      ok(req, res, await deps.contention.getById(req.params.id as string));
    }),
  };
}

export type ContentionController = ReturnType<typeof createContentionController>;
