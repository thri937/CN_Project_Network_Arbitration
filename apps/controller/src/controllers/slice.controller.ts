import type { Request, Response } from 'express';
import type { HealthState, SliceProfile, SliceStatus } from '@/constants/enums';
import { requireActor } from '@/middleware/authenticate';
import type { PaginationQuery } from '@/models/base.model';
import {
  currentDegradationFraction,
  degradableHeadroomMbps,
  isArbitrable,
  type CreateSlicePayload,
  type Slice,
  type UpdateSlicePayload,
} from '@/models/slice.model';
import type { SliceService } from '@/services/slice.service';
import { asyncHandler } from '@/utils/asyncHandler';
import { created, noContent, ok, paginated } from '@/utils/http';
import { round } from '@/utils/math';

/**
 * Slice endpoints.
 *
 * Responses carry derived fields the dashboard needs on every render — degradation depth,
 * remaining headroom, whether the slice is in the arbitration pool. Computing them
 * server-side means the NOC view and the arbitration engine cannot disagree about how
 * degraded a slice is, which would be a genuinely dangerous discrepancy during an incident.
 */
export function createSliceController(deps: { slices: SliceService }) {
  const enrich = (slice: Slice) => ({
    ...slice,
    degradationPercent: round(currentDegradationFraction(slice) * 100, 2),
    degradableHeadroomMbps: round(degradableHeadroomMbps(slice), 2),
    arbitrable: isArbitrable(slice),
    utilisationOfBurstPercent:
      slice.maxBurstMbps > 0 ? round((slice.allocatedMbps / slice.maxBurstMbps) * 100, 2) : 0,
  });

  return {
    /** GET /slices */
    list: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as PaginationQuery & {
        departmentId?: string;
        status?: SliceStatus;
        profile?: SliceProfile;
        health?: HealthState;
      };

      const page = await deps.slices.list(
        {
          ...(query.departmentId ? { departmentId: query.departmentId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.profile ? { profile: query.profile } : {}),
          ...(query.health ? { health: query.health } : {}),
        },
        { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
      );

      paginated(req, res, { ...page, items: page.items.map(enrich) }, query.limit);
    }),

    /** GET /slices/headroom — admission-control status, shown before creating a slice. */
    headroom: asyncHandler(async (req: Request, res: Response) => {
      ok(req, res, await deps.slices.admissionHeadroom());
    }),

    /** GET /slices/topology — slices joined with departments, for the topology view. */
    topology: asyncHandler(async (req: Request, res: Response) => {
      const enriched = await deps.slices.listEnriched();
      ok(
        req,
        res,
        enriched.map(({ slice, department }) => ({
          slice: enrich(slice),
          department: department
            ? {
                id: department.id,
                name: department.name,
                code: department.code,
                criticality: department.criticality,
                complianceLevel: department.complianceLevel,
                site: department.site,
              }
            : null,
        })),
      );
    }),

    /** GET /slices/:id */
    getById: asyncHandler(async (req: Request, res: Response) => {
      ok(req, res, enrich(await deps.slices.getById(req.params.id as string)));
    }),

    /** POST /slices */
    create: asyncHandler(async (req: Request, res: Response) => {
      const slice = await deps.slices.create(req.body as CreateSlicePayload, requireActor(req));
      created(req, res, enrich(slice), `/slices/${slice.id}`);
    }),

    /** PATCH /slices/:id */
    update: asyncHandler(async (req: Request, res: Response) => {
      const slice = await deps.slices.update(
        req.params.id as string,
        req.body as UpdateSlicePayload,
        requireActor(req),
      );
      ok(req, res, enrich(slice));
    }),

    /** POST /slices/:id/pause */
    pause: asyncHandler(async (req: Request, res: Response) => {
      const { reason } = req.body as { reason: string };
      const slice = await deps.slices.pause(req.params.id as string, reason, requireActor(req));
      ok(req, res, enrich(slice));
    }),

    /** POST /slices/:id/resume */
    resume: asyncHandler(async (req: Request, res: Response) => {
      const slice = await deps.slices.resume(req.params.id as string, requireActor(req));
      ok(req, res, enrich(slice));
    }),

    /** DELETE /slices/:id */
    remove: asyncHandler(async (req: Request, res: Response) => {
      const result = await deps.slices.delete(req.params.id as string, requireActor(req));
      // A slice with arbitration history is terminated rather than removed, so the caller
      // is told which happened instead of being left to infer it.
      if (result.deleted) return noContent(res);
      ok(req, res, { deleted: false, status: 'TERMINATED', reason: 'slice has arbitration history' });
    }),
  };
}

export type SliceController = ReturnType<typeof createSliceController>;
