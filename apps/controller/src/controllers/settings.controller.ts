import type { Request, Response } from 'express';
import { env, OFFERED_CAPACITY_MBPS } from '@/config/env';
import { requireActor } from '@/middleware/authenticate';
import type { UpdateSettingsPayload } from '@/models/settings.model';
import type { ArbitrationService } from '@/services/arbitration.service';
import type { CapacityService } from '@/services/capacity.service';
import type { ContentionService } from '@/services/contention.service';
import type { SettingsService } from '@/services/settings.service';
import type { SliceService } from '@/services/slice.service';
import type { TelemetryService } from '@/services/telemetry.service';
import type { DepartmentService } from '@/services/department.service';
import type { JobScheduler } from '@/jobs/scheduler';
import { asyncHandler } from '@/utils/asyncHandler';
import { ok } from '@/utils/http';
import { round } from '@/utils/math';

/**
 * Settings, system status and reports.
 *
 * `/settings/system` is the operator's answer to "what is this deployment actually doing?".
 * It exposes the active adapter wiring, job statistics and control-loop state in one place,
 * because during an incident the first question is invariably whether the platform is even
 * running as configured.
 */
export function createSettingsController(deps: {
  settings: SettingsService;
  telemetry: TelemetryService;
  capacity: CapacityService;
  contention: ContentionService;
  arbitration: ArbitrationService;
  slices: SliceService;
  departments: DepartmentService;
  scheduler: JobScheduler;
  autoArbitration: { enabled: boolean };
}) {
  return {
    /** GET /settings */
    get: asyncHandler(async (req: Request, res: Response) => {
      ok(req, res, await deps.settings.get());
    }),

    /** PATCH /settings — ADMIN. */
    update: asyncHandler(async (req: Request, res: Response) => {
      const updated = await deps.settings.update(
        req.body as UpdateSettingsPayload,
        requireActor(req),
      );
      ok(req, res, updated);
    }),

    /** GET /settings/system — deployment wiring and runtime state. */
    system: asyncHandler(async (req: Request, res: Response) => {
      ok(req, res, {
        adapters: {
          datastore: env.DATASTORE_DRIVER,
          auth: env.AUTH_DRIVER,
          telemetry: deps.telemetry.networkProvider.name,
          telemetryCapabilities: deps.telemetry.networkProvider.capabilities(),
        },
        network: {
          totalCapacityMbps: env.NETWORK_TOTAL_CAPACITY_MBPS,
          reservedCapacityMbps: env.NETWORK_RESERVED_CAPACITY_MBPS,
          offeredCapacityMbps: OFFERED_CAPACITY_MBPS,
        },
        controlLoop: {
          autoArbitration: deps.autoArbitration.enabled,
          telemetryTickMs: env.TELEMETRY_TICK_MS,
          snapshotAgeMs: deps.telemetry.getSnapshot() ? deps.telemetry.snapshotAgeMs() : null,
          telemetryHealth: deps.telemetry.healthProbe(),
          openContention: deps.contention.getOpenEvent()?.id ?? null,
        },
        jobs: deps.scheduler.stats(),
        uptimeSeconds: Math.floor(process.uptime()),
        version: process.env.npm_package_version ?? '1.0.0',
        environment: env.NODE_ENV,
      });
    }),

    /**
     * GET /reports/overview — the executive summary.
     *
     * Deliberately leads with `harmAvoidedVsPrioritySortPercent`: the whole justification
     * for this platform over a conventional QoS controller is that it causes measurably
     * less business harm, and that claim should be the first number on the page rather than
     * an assertion in a slide deck.
     */
    reportOverview: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as { from?: string; to?: string };

      const [arbitrationSummary, departmentSummaries, headroom] = await Promise.all([
        deps.arbitration.summarise({
          ...(query.from ? { fromMs: Date.parse(query.from) } : {}),
          ...(query.to ? { toMs: Date.parse(query.to) } : {}),
        }),
        deps.departments.summarise(),
        deps.slices.admissionHeadroom(),
      ]);

      const capacityState = deps.capacity.getState();

      ok(req, res, {
        window: { fromMs: arbitrationSummary.fromMs, toMs: arbitrationSummary.toMs },

        headline: {
          arbitrationRuns: arbitrationSummary.total,
          bandwidthFreedMbps: arbitrationSummary.totalBandwidthFreedMbps,
          meanConfidence: arbitrationSummary.meanConfidence,
          harmAvoidedVsPrioritySortPercent: arbitrationSummary.harmAvoidedVsPrioritySortPercent,
        },

        outcomes: arbitrationSummary.byOutcome,
        degradationsByDepartment: arbitrationSummary.degradationsByDepartment,

        capacity: capacityState
          ? {
              level: capacityState.level,
              utilisation: capacityState.utilisation,
              demandRatio: capacityState.demandRatio,
              oversubscribed: capacityState.oversubscribed,
              availableMbps: capacityState.availableMbps,
            }
          : null,

        admission: headroom,

        departments: departmentSummaries.map((entry) => ({
          departmentId: entry.department.id,
          name: entry.department.name,
          criticality: entry.department.criticality,
          complianceLevel: entry.department.complianceLevel,
          sliceCount: entry.sliceCount,
          allocatedMbps: entry.allocatedMbps,
          degradedSliceCount: entry.degradedSliceCount,
          effectiveDegradationCeiling: entry.effectiveDegradationCeiling,
          shareOfCapacityPercent: round(
            (entry.allocatedMbps / Math.max(OFFERED_CAPACITY_MBPS, 1)) * 100,
            2,
          ),
        })),
      });
    }),
  };
}

export type SettingsController = ReturnType<typeof createSettingsController>;
