import type { Request, Response } from 'express';
import type { ComplianceLevel, DepartmentCriticality } from '@/constants/enums';
import type { PaginationQuery } from '@/models/base.model';
import {
  effectiveDegradationCeiling,
  isStructurallyExempt,
  type CreateDepartmentPayload,
  type Department,
  type UpdateDepartmentPayload,
} from '@/models/department.model';
import { requireActor } from '@/middleware/authenticate';
import type { DepartmentService } from '@/services/department.service';
import { asyncHandler } from '@/utils/asyncHandler';
import { created, noContent, ok, paginated } from '@/utils/http';

/**
 * Department endpoints.
 *
 * Responses are enriched with two DERIVED fields that the client would otherwise have to
 * recompute — and would inevitably recompute differently:
 *
 *   `effectiveDegradationCeiling`  the tighter of the department's own limit and its
 *                                  compliance ceiling. This is the number arbitration
 *                                  actually obeys, so it is the number an operator must see.
 *   `structurallyExempt`           whether compliance forbids ANY degradation.
 *
 * Deriving them server-side means the dashboard cannot show a 60 % limit while the engine
 * silently enforces 20 %.
 */
export function createDepartmentController(deps: { departments: DepartmentService }) {
  const enrich = (department: Department) => ({
    ...department,
    effectiveDegradationCeiling: effectiveDegradationCeiling(department),
    structurallyExempt: isStructurallyExempt(department),
  });

  return {
    /** GET /departments */
    list: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as PaginationQuery & {
        criticality?: DepartmentCriticality;
        complianceLevel?: ComplianceLevel;
        active?: boolean;
      };

      const page = await deps.departments.list(
        {
          ...(query.criticality ? { criticality: query.criticality } : {}),
          ...(query.complianceLevel ? { complianceLevel: query.complianceLevel } : {}),
          ...(query.active !== undefined ? { active: query.active } : {}),
        },
        { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
      );

      paginated(req, res, { ...page, items: page.items.map(enrich) }, query.limit);
    }),

    /** GET /departments/summary — slice counts and allocation per department. */
    summary: asyncHandler(async (req: Request, res: Response) => {
      const summaries = await deps.departments.summarise();
      ok(
        req,
        res,
        summaries.map((entry) => ({ ...entry, department: enrich(entry.department) })),
      );
    }),

    /** GET /departments/:id */
    getById: asyncHandler(async (req: Request, res: Response) => {
      const department = await deps.departments.getById(req.params.id as string);
      ok(req, res, enrich(department));
    }),

    /** POST /departments */
    create: asyncHandler(async (req: Request, res: Response) => {
      const department = await deps.departments.create(
        req.body as CreateDepartmentPayload,
        requireActor(req),
      );
      created(req, res, enrich(department), `/departments/${department.id}`);
    }),

    /** PATCH /departments/:id */
    update: asyncHandler(async (req: Request, res: Response) => {
      const department = await deps.departments.update(
        req.params.id as string,
        req.body as UpdateDepartmentPayload,
        requireActor(req),
      );
      ok(req, res, enrich(department));
    }),

    /** DELETE /departments/:id */
    remove: asyncHandler(async (req: Request, res: Response) => {
      await deps.departments.delete(req.params.id as string, requireActor(req));
      noContent(res);
    }),
  };
}

export type DepartmentController = ReturnType<typeof createDepartmentController>;
