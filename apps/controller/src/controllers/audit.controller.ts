import type { Request, Response } from 'express';
import { requirePrincipal } from '@/middleware/authenticate';
import type { PaginationQuery } from '@/models/base.model';
import type { AuditLogQuery } from '@/models/auditLog.model';
import type { NotificationSeverity } from '@/constants/enums';
import type { MarkReadSchema } from '@/models/notification.model';
import type { AuditService } from '@/services/audit.service';
import type { NotificationService } from '@/services/notification.service';
import { asyncHandler } from '@/utils/asyncHandler';
import { ok, paginated } from '@/utils/http';
import type { z } from 'zod';

/**
 * Audit and notification endpoints.
 *
 * The audit surface is READ-ONLY and has no mutation route of any kind — not even for an
 * administrator. An audit trail that can be edited by the people it holds to account is not
 * an audit trail. Immutability is enforced in three independent places: no endpoint here,
 * no mutating method on `AuditService`, and a hard deny in the Firestore security rules.
 */
export function createAuditController(deps: {
  audit: AuditService;
  notifications: NotificationService;
}) {
  return {
    /** GET /audit — paginated, filterable audit log. ADMIN only. */
    list: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as PaginationQuery & AuditLogQuery;

      const page = await deps.audit.query(query, {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });

      paginated(req, res, page, query.limit);
    }),

    /** GET /audit/:id */
    getById: asyncHandler(async (req: Request, res: Response) => {
      const entry = await deps.audit.findById(req.params.id as string);
      ok(req, res, entry);
    }),

    /**
     * GET /audit/timeline/:targetId — everything that happened to one thing, in order.
     *
     * The query an investigator actually starts from: "show me everything that happened to
     * the cardiology slice between 14:00 and 15:00".
     */
    timeline: asyncHandler(async (req: Request, res: Response) => {
      const entries = await deps.audit.timelineFor(req.params.targetId as string, 200);
      ok(req, res, { targetId: req.params.targetId, entries, count: entries.length });
    }),

    /* ---- Notifications ------------------------------------------------ */

    /** GET /notifications — the caller's own notifications plus visible broadcasts. */
    listNotifications: asyncHandler(async (req: Request, res: Response) => {
      const principal = requirePrincipal(req);
      const query = req.query as unknown as PaginationQuery & {
        unreadOnly?: boolean;
        severity?: NotificationSeverity;
      };

      const notifications = await deps.notifications.forUser(
        principal.userId,
        principal.role,
        {
          ...(query.unreadOnly !== undefined ? { unreadOnly: query.unreadOnly } : {}),
          ...(query.severity ? { severity: query.severity } : {}),
        },
        { limit: query.limit },
      );

      ok(req, res, notifications);
    }),

    /** GET /notifications/unread-count — drives the badge in the app shell. */
    unreadCount: asyncHandler(async (req: Request, res: Response) => {
      const principal = requirePrincipal(req);
      const count = await deps.notifications.unreadCount(principal.userId, principal.role);
      ok(req, res, { count });
    }),

    /** POST /notifications/read */
    markRead: asyncHandler(async (req: Request, res: Response) => {
      const principal = requirePrincipal(req);
      const { ids } = req.body as z.infer<typeof MarkReadSchema>;
      const updated = await deps.notifications.markRead(ids, principal.userId, principal.role);
      ok(req, res, { updated });
    }),
  };
}

export type AuditController = ReturnType<typeof createAuditController>;
