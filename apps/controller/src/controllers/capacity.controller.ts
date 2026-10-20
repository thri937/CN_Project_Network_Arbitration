import type { Request, Response } from 'express';
import { env } from '@/config/env';
import { CapacityTunables } from '@/constants/tunables';
import type { IClock } from '@/interfaces/clock.port';
import type { CapacityService } from '@/services/capacity.service';
import type { SliceService } from '@/services/slice.service';
import { asyncHandler } from '@/utils/asyncHandler';
import { ok } from '@/utils/http';
import { round } from '@/utils/math';

/**
 * Capacity endpoints.
 *
 * `/capacity` returns the live in-memory measurement plus the admission-control view, so
 * the dashboard renders the whole capacity picture from one request rather than stitching
 * together three. It deliberately exposes all three ratios — utilisation, allocation and
 * demand — because they answer different questions and a UI that shows only utilisation
 * cannot distinguish "full" from "badly oversubscribed".
 */
export function createCapacityController(deps: {
  capacity: CapacityService;
  slices: SliceService;
  /** Default ranges must come from the clock that stamped the data — see telemetry.controller. */
  clock: IClock;
}) {
  return {
    /** GET /capacity — live network capacity state. */
    current: asyncHandler(async (req: Request, res: Response) => {
      const state = deps.capacity.getState();
      const headroom = await deps.slices.admissionHeadroom();

      ok(req, res, {
        capacity: state,
        admission: headroom,
        bandwidthUnit: env.BANDWIDTH_UNIT,
        thresholds: {
          warningUtilisation: CapacityTunables.WARNING_UTILISATION,
          criticalUtilisation: CapacityTunables.CRITICAL_UTILISATION,
        },
        available: state !== null,
      });
    }),

    /** GET /capacity/series — historical capacity for the Analytics page. */
    series: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as { from?: string; to?: string; limit: number };

      const toMs = query.to ? Date.parse(query.to) : deps.clock.now();
      const fromMs = query.from ? Date.parse(query.from) : toMs - 6 * 60 * 60 * 1000;

      const samples = await deps.capacity.series(fromMs, toMs, query.limit);

      ok(req, res, {
        fromMs,
        toMs,
        points: samples.length,
        samples,
        // Pre-computed so the client does not re-derive it differently.
        summary: summarise(samples),
      });
    }),
  };
}

function summarise(
  samples: { utilisation: number; demandRatio: number; level: string }[],
): {
  peakUtilisation: number;
  meanUtilisation: number;
  peakDemandRatio: number;
  oversubscribedSamples: number;
  oversubscribedPercent: number;
} | null {
  if (samples.length === 0) return null;

  const utilisations = samples.map((s) => s.utilisation);
  const demandRatios = samples.map((s) => s.demandRatio);
  const oversubscribed = samples.filter((s) => s.demandRatio > 1).length;

  return {
    peakUtilisation: round(Math.max(...utilisations), 4),
    meanUtilisation: round(utilisations.reduce((a, b) => a + b, 0) / samples.length, 4),
    peakDemandRatio: round(Math.max(...demandRatios), 4),
    oversubscribedSamples: oversubscribed,
    oversubscribedPercent: round((oversubscribed / samples.length) * 100, 2),
  };
}

export type CapacityController = ReturnType<typeof createCapacityController>;
