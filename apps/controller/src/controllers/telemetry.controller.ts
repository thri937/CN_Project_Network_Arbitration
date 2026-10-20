import type { Request, Response } from 'express';
import type { IClock } from '@/interfaces/clock.port';
import type { PaginationQuery } from '@/models/base.model';
import type { TelemetryQuery } from '@/models/telemetry.model';
import type { TelemetryRepository } from '@/repositories/telemetry.repository';
import type { TelemetryService } from '@/services/telemetry.service';
import { isSyntheticProvider, type FaultKind } from '@/telemetry';
import { asyncHandler } from '@/utils/asyncHandler';
import { ConflictError, NotFoundError, NotImplementedError } from '@/utils/errors';
import { ok, paginated } from '@/utils/http';

/**
 * Telemetry endpoints.
 *
 * `GET /telemetry/live` returns the in-memory snapshot the control loop is actually acting
 * on — not a datastore query. That distinction is deliberate: an operator watching the
 * dashboard during an incident must see exactly the view the arbitration engine sees, not
 * a lagging persisted copy of it. `snapshotAgeMs` is included so staleness is visible
 * rather than inferred.
 *
 * The fault-injection endpoints exist only when the synthetic provider is active. Against a
 * live network the equivalent is a traffic generator, which is not this platform's job.
 */
export function createTelemetryController(deps: {
  telemetry: TelemetryService;
  repository: TelemetryRepository;
  /**
   * Injected rather than using `Date.now()`.
   *
   * Default time ranges MUST come from the same clock that stamped the data. Mixing the two
   * produces a window that silently excludes every real sample whenever the clocks differ —
   * which is what a replay run, a time-travelling test, or a badly skewed host does.
   */
  clock: IClock;
}) {
  const requireSynthetic = () => {
    const provider = deps.telemetry.networkProvider;
    if (!isSyntheticProvider(provider)) {
      throw new ConflictError(
        `Fault injection is only available with the synthetic telemetry provider ` +
          `(active provider: '${provider.name}'). Against a live network, drive load with a traffic generator.`,
      );
    }
    return provider;
  };

  return {
    /** GET /telemetry/live — the snapshot the control loop is acting on right now. */
    live: asyncHandler(async (req: Request, res: Response) => {
      const snapshot = deps.telemetry.getSnapshot();
      ok(req, res, {
        snapshot,
        snapshotAgeMs: snapshot ? deps.telemetry.snapshotAgeMs() : null,
        // Surfaced so the UI can show "stale" instead of quietly rendering old numbers.
        stale: snapshot === null || deps.telemetry.snapshotAgeMs() > 15_000,
      });
    }),

    /** GET /telemetry/live/:sliceId */
    liveSlice: asyncHandler(async (req: Request, res: Response) => {
      const sliceId = req.params.sliceId as string;
      const state = deps.telemetry.getSliceState(sliceId);
      if (!state) throw new NotFoundError('Live telemetry for slice', sliceId);
      ok(req, res, state);
    }),

    /** GET /telemetry — paginated historical query. */
    query: asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as PaginationQuery & TelemetryQuery;

      const page = await deps.repository.query(
        {
          ...(query.sliceId ? { sliceId: query.sliceId } : {}),
          ...(query.departmentId ? { departmentId: query.departmentId } : {}),
          ...(query.from ? { fromMs: Date.parse(query.from) } : {}),
          ...(query.to ? { toMs: Date.parse(query.to) } : {}),
        },
        { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
      );

      paginated(req, res, page, query.limit);
    }),

    /** GET /telemetry/series/:sliceId — chart-ready time series, oldest first. */
    series: asyncHandler(async (req: Request, res: Response) => {
      const sliceId = req.params.sliceId as string;
      const query = req.query as unknown as { from?: string; to?: string; limit: number };

      const toMs = query.to ? Date.parse(query.to) : deps.clock.now();
      // One hour is the default window: long enough to contain a full contention and
      // recovery cycle, short enough to stay under the query limit at 10 s resolution.
      const fromMs = query.from ? Date.parse(query.from) : toMs - 60 * 60 * 1000;

      const samples = await deps.repository.seriesForSlice(sliceId, fromMs, toMs, query.limit);
      ok(req, res, { sliceId, fromMs, toMs, points: samples.length, samples });
    }),

    /** GET /telemetry/provider — active provider, capabilities and simulation state. */
    provider: asyncHandler(async (req: Request, res: Response) => {
      const provider = deps.telemetry.networkProvider;
      ok(req, res, {
        name: provider.name,
        capabilities: provider.capabilities(),
        capacity: await provider.describeCapacity(),
        health: deps.telemetry.healthProbe(),
        ...(isSyntheticProvider(provider) ? { simulation: provider.describeState() } : {}),
      });
    }),

    /** POST /telemetry/faults — synthetic provider only. */
    injectFault: asyncHandler(async (req: Request, res: Response) => {
      const provider = requireSynthetic();
      const body = req.body as { sliceId: string; kind: FaultKind; durationTicks: number };

      const injected = provider.injectFault(body.sliceId, body.kind, body.durationTicks);
      if (!injected) {
        throw new NotFoundError(
          'Slice in the telemetry simulation',
          `${body.sliceId} (the slice must have been sampled at least once)`,
        );
      }

      ok(req, res, {
        sliceId: body.sliceId,
        kind: body.kind,
        durationTicks: body.durationTicks,
        simulation: provider.describeState(),
      });
    }),

    /** DELETE /telemetry/faults/:sliceId */
    clearFault: asyncHandler(async (req: Request, res: Response) => {
      const provider = requireSynthetic();
      const sliceId = req.params.sliceId as string;
      if (!provider.clearFault(sliceId)) {
        throw new NotFoundError('Slice in the telemetry simulation', sliceId);
      }
      ok(req, res, { sliceId, cleared: true });
    }),

    /** POST /telemetry/load — scale demand fleet-wide to drive the network into contention. */
    setLoad: asyncHandler(async (req: Request, res: Response) => {
      const provider = requireSynthetic();
      const { multiplier } = req.body as { multiplier: number };
      ok(req, res, {
        globalLoadMultiplier: provider.setGlobalLoad(multiplier),
        simulation: provider.describeState(),
      });
    }),
  };
}

export type TelemetryController = ReturnType<typeof createTelemetryController>;
