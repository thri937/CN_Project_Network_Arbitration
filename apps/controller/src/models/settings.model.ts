import { z } from 'zod';
import { auditableShape, displayNameSchema } from './base.model';

/**
 * Platform settings — a single document (`settings/global`).
 *
 * DELIBERATELY NARROW.
 * ====================
 * Nothing that affects an arbitration OUTCOME lives here. Weights, ceilings and tuning
 * belong to `Policy`, which is versioned, immutable once active, and snapshotted into every
 * decision. Settings hold only presentation and operational preferences — things that can
 * change without invalidating the explanation of a past decision.
 *
 * Splitting them this way is what keeps the audit trail meaningful: if the fairness lambda
 * could be changed here, a decision's recorded policy snapshot would no longer describe the
 * rules that actually produced it.
 */
export const SettingsSchema = z.object({
  ...auditableShape,

  organisationName: displayNameSchema.default('Enterprise Network Operations'),

  /** Currency label for downtime-cost figures. Presentation only. */
  currencyCode: z.string().trim().length(3).toUpperCase().default('USD'),
  currencySymbol: z.string().trim().max(4).default('$'),

  /* ---- Operational preferences ------------------------------------- */

  /**
   * Master switch for automatic arbitration.
   *
   * Turning it off leaves detection and simulation running while suspending action — the
   * correct posture during a planned maintenance window, when a human should decide.
   */
  autoArbitrationEnabled: z.boolean().default(true),

  /** Suppress automatic action inside a maintenance window. */
  maintenanceMode: z.boolean().default(false),
  maintenanceReason: z.string().trim().max(500).optional(),

  /* ---- Dashboard ---------------------------------------------------- */

  dashboard: z
    .object({
      /** Client poll interval when the realtime socket is unavailable. */
      pollIntervalMs: z.number().int().min(1000).max(60_000).default(2000),
      /** Points retained in the live charts. */
      chartWindowPoints: z.number().int().min(20).max(2000).default(120),
      defaultTheme: z.enum(['light', 'dark', 'system']).default('dark'),
    })
    .default({ pollIntervalMs: 2000, chartWindowPoints: 120, defaultTheme: 'dark' }),

  /* ---- Notification channels (email/Slack/Teams are future work) ---- */

  notifications: z
    .object({
      dashboardEnabled: z.boolean().default(true),
      emailEnabled: z.boolean().default(false),
      slackEnabled: z.boolean().default(false),
      teamsEnabled: z.boolean().default(false),
      /** Minimum severity that generates a broadcast. */
      minimumSeverity: z.enum(['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL']).default('WARNING'),
    })
    .default({
      dashboardEnabled: true,
      emailEnabled: false,
      slackEnabled: false,
      teamsEnabled: false,
      minimumSeverity: 'WARNING',
    }),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const UpdateSettingsSchema = z
  .object({
    organisationName: displayNameSchema.optional(),
    currencyCode: z.string().trim().length(3).toUpperCase().optional(),
    currencySymbol: z.string().trim().max(4).optional(),
    autoArbitrationEnabled: z.boolean().optional(),
    maintenanceMode: z.boolean().optional(),
    maintenanceReason: z.string().trim().max(500).optional(),
    dashboard: z
      .object({
        pollIntervalMs: z.number().int().min(1000).max(60_000).optional(),
        chartWindowPoints: z.number().int().min(20).max(2000).optional(),
        defaultTheme: z.enum(['light', 'dark', 'system']).optional(),
      })
      .optional(),
    notifications: z
      .object({
        dashboardEnabled: z.boolean().optional(),
        emailEnabled: z.boolean().optional(),
        slackEnabled: z.boolean().optional(),
        teamsEnabled: z.boolean().optional(),
        minimumSeverity: z.enum(['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL']).optional(),
      })
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be supplied',
  });

export type UpdateSettingsPayload = z.infer<typeof UpdateSettingsSchema>;

export function defaultSettings(): Omit<Settings, 'id' | 'createdAt' | 'updatedAt' | 'version'> {
  return SettingsSchema.omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    version: true,
    createdBy: true,
    updatedBy: true,
  }).parse({});
}
