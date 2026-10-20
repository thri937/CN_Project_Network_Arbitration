import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { capacityApi, contentionApi, departmentsApi, slicesApi, telemetryApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import { useRealtime } from '@/realtime/RealtimeProvider';
import type { CapacityState, Department, LiveSliceState, NetworkSnapshot, Slice } from '@/types/api';

/**
 * Live-data hooks.
 *
 * Each wraps a React Query subscription whose cache key the realtime provider also writes
 * to. A component calling `useTelemetry()` receives socket pushes when the socket is up and
 * polled data when it is not, with no code path difference — the poll interval simply
 * becomes a backstop rather than the primary source.
 */

/** Poll fast when there is no socket; slowly when there is, purely as a liveness check. */
function interval(connected: boolean, fast = 2000, slow = 20_000): number {
  return connected ? slow : fast;
}

export function useTelemetry() {
  const { connected } = useRealtime();

  return useQuery({
    queryKey: queryKeys.telemetry.live(),
    queryFn: telemetryApi.live,
    refetchInterval: interval(connected),
  });
}

export function useCapacity() {
  const { connected } = useRealtime();

  return useQuery({
    queryKey: queryKeys.capacity.current(),
    queryFn: capacityApi.current,
    refetchInterval: interval(connected),
  });
}

export function useContention() {
  const { connected } = useRealtime();

  return useQuery({
    queryKey: queryKeys.contention.current(),
    queryFn: contentionApi.current,
    refetchInterval: interval(connected, 3000, 15_000),
  });
}

/**
 * Slices, joined with their departments.
 *
 * Departments are cached for a minute: they change through a form, not on a timer, and
 * refetching them at telemetry cadence would be pure waste. Slices are refetched more
 * eagerly because arbitration mutates their allocation.
 */
export function useSlicesWithDepartments() {
  const slices = useQuery({
    queryKey: queryKeys.slices.list(),
    queryFn: slicesApi.listAll,
    refetchInterval: 10_000,
  });

  const departments = useQuery({
    queryKey: queryKeys.departments.list(),
    queryFn: departmentsApi.listAll,
    staleTime: 60_000,
  });

  const byId = useMemo(() => {
    const map = new Map<string, Department>();
    for (const department of departments.data ?? []) map.set(department.id, department);
    return map;
  }, [departments.data]);

  return {
    slices: slices.data ?? [],
    departmentById: byId,
    departments: departments.data ?? [],
    isLoading: slices.isLoading || departments.isLoading,
    error: slices.error ?? departments.error,
    refetch: () => {
      void slices.refetch();
      void departments.refetch();
    },
  };
}

/**
 * Merge the live telemetry snapshot onto the persisted slice records.
 *
 * The two carry different things: the slice record has the contract (baseline, floor, SLA
 * targets, department), the snapshot has the runtime state (demand, latency, stress). The
 * dashboard needs both on one card, and joining them in one place stops each component
 * re-deriving the join slightly differently.
 */
export interface MergedSlice {
  slice: Slice;
  live: LiveSliceState | null;
  department: Department | null;
}

export function useMergedSlices(): {
  merged: MergedSlice[];
  snapshot: NetworkSnapshot | null;
  stale: boolean;
  isLoading: boolean;
} {
  const telemetry = useTelemetry();
  const { slices, departmentById, isLoading } = useSlicesWithDepartments();

  const snapshot = telemetry.data?.snapshot ?? null;

  const merged = useMemo(() => {
    const liveById = new Map<string, LiveSliceState>();
    for (const state of snapshot?.slices ?? []) liveById.set(state.sliceId, state);

    return slices
      .map((slice) => ({
        slice,
        live: liveById.get(slice.id) ?? null,
        department: departmentById.get(slice.departmentId) ?? null,
      }))
      // Degraded slices first, then by business criticality of the department, then by
      // name. An operator scanning the wall should meet the problems before the healthy
      // majority.
      .sort((a, b) => {
        const aDegraded = a.slice.status === 'DEGRADED' ? 0 : 1;
        const bDegraded = b.slice.status === 'DEGRADED' ? 0 : 1;
        if (aDegraded !== bDegraded) return aDegraded - bDegraded;

        // Unknown or missing criticality sorts last rather than crashing the comparator.
        const rank = (d: Department | null) =>
          CRITICALITY_RANK[d?.criticality ?? 'BEST_EFFORT'] ?? 99;
        const byCriticality = rank(a.department) - rank(b.department);
        if (byCriticality !== 0) return byCriticality;

        return a.slice.name.localeCompare(b.slice.name);
      });
  }, [slices, snapshot, departmentById]);

  return {
    merged,
    snapshot,
    stale: telemetry.data?.stale ?? true,
    isLoading: isLoading || telemetry.isLoading,
  };
}

const CRITICALITY_RANK: Record<string, number> = {
  MISSION_CRITICAL: 0,
  BUSINESS_CRITICAL: 1,
  BUSINESS_OPERATIONAL: 2,
  ADMINISTRATIVE: 3,
  BEST_EFFORT: 4,
};

/* ------------------------------------------------------------------ */
/* Rolling history                                                     */
/* ------------------------------------------------------------------ */

export interface TimePoint {
  t: number;
  [series: string]: number;
}

/**
 * Accumulate a rolling in-memory series from the live snapshot.
 *
 * The alternative — querying the persisted telemetry collection — is deliberately not used
 * for the live charts. Storage is throttled to every Nth tick, so a chart drawn from it
 * would move in visible steps while the numbers beside it updated smoothly, which looks
 * broken. This keeps the chart at exactly the cadence of the data driving the rest of the
 * page.
 *
 * History is per-mount and intentionally not persisted: a dashboard reopened after an hour
 * should show the last few minutes, not a gap.
 */
export function useRollingSeries<T>(
  value: T | null | undefined,
  project: (value: T) => Omit<TimePoint, 't'> | null,
  options: { maxPoints?: number; timestamp?: (value: T) => number } = {},
): TimePoint[] {
  const maxPoints = options.maxPoints ?? 120;
  const [series, setSeries] = useState<TimePoint[]>([]);
  const lastTimestamp = useRef<number>(0);

  useEffect(() => {
    if (value === null || value === undefined) return;

    const t = options.timestamp?.(value) ?? Date.now();
    // Guard against a repeated identical snapshot (a refetch that returned the same tick)
    // appending a duplicate point and flattening the chart.
    if (t <= lastTimestamp.current) return;
    lastTimestamp.current = t;

    const projected = project(value);
    if (!projected) return;

    setSeries((previous) => {
      const next = [...previous, { t, ...projected }];
      return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
    });
    // `project` is a fresh closure each render; depending on it would append on every
    // render rather than on every new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, maxPoints]);

  return series;
}

/** Convenience: the network-wide capacity series for the dashboard header chart. */
export function useCapacitySeries(maxPoints = 120): TimePoint[] {
  const { data } = useCapacity();
  const capacity = data?.capacity ?? null;

  return useRollingSeries<CapacityState>(
    capacity,
    (state) => ({
      demand: state.demandMbps,
      allocated: state.allocatedMbps,
      used: state.usedMbps,
      capacity: state.offeredCapacityMbps,
    }),
    { maxPoints, timestamp: (state) => state.atMs },
  );
}
