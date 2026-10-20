import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { telemetryApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/auth/AuthProvider';
import { useMergedSlices, useRollingSeries } from '@/hooks/useLiveData';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LoadingState,
  PageHeader,
  Tooltip,
} from '@/components/ui';
import { MetricChart } from '@/components/charts/LiveChart';
import { SliceCard } from '@/components/SliceCard';
import {
  formatBandwidth,
  formatLatency,
  formatPercent,
  healthStyle,
  humanise,
  statusStyles,
} from '@/lib/format';
import type { LiveSliceState } from '@/types/api';

/**
 * Runtime monitoring.
 *
 * Per-slice detail: pick a slice, watch its metrics evolve. The charts are fed from the
 * live snapshot rather than the persisted telemetry collection, because storage is
 * throttled — a chart drawn from it would step visibly while the numbers beside it moved
 * smoothly, which reads as a bug.
 *
 * The synthetic-provider controls are here rather than hidden in settings: driving the
 * network into contention is how an operator rehearses a runbook or demonstrates the
 * platform, and it belongs beside the display it affects.
 */
export function MonitoringPage(): JSX.Element {
  const { isManager } = useAuth();
  const queryClient = useQueryClient();
  const { merged, snapshot, isLoading } = useMergedSlices();

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: provider } = useQuery({
    queryKey: queryKeys.telemetry.provider(),
    queryFn: telemetryApi.provider,
    refetchInterval: 10_000,
  });

  const selected = merged.find((entry) => entry.slice.id === selectedId) ?? merged[0] ?? null;
  const live = selected?.live ?? null;

  /* Rolling per-slice series, keyed off the observation timestamp so a repeated snapshot
     does not append a duplicate point. */
  const throughput = useRollingSeries<LiveSliceState>(
    live,
    (state) => ({ demand: state.demandMbps, used: state.usedMbps, allocated: state.allocatedMbps }),
    { maxPoints: 120, timestamp: (state) => state.observedAtMs },
  );

  const quality = useRollingSeries<LiveSliceState>(
    live,
    (state) => ({ latency: state.latencyMs, jitter: state.jitterMs }),
    { maxPoints: 120, timestamp: (state) => state.observedAtMs },
  );

  const lossSeries = useRollingSeries<LiveSliceState>(
    live,
    (state) => ({ loss: state.packetLossPercent }),
    { maxPoints: 120, timestamp: (state) => state.observedAtMs },
  );

  const compute = useRollingSeries<LiveSliceState>(
    live,
    (state) => ({ cpu: state.cpuPercent, memory: state.memoryPercent }),
    { maxPoints: 120, timestamp: (state) => state.observedAtMs },
  );

  const setLoad = useMutation({
    mutationFn: (multiplier: number) => telemetryApi.setLoad(multiplier),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.telemetry.provider() });
    },
  });

  const injectFault = useMutation({
    mutationFn: ({ sliceId, kind }: { sliceId: string; kind: string }) =>
      telemetryApi.injectFault(sliceId, kind, 40),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.telemetry.provider() });
    },
  });

  if (isLoading) return <LoadingState label="Loading telemetry" />;

  const synthetic = provider?.simulation;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Runtime Monitoring"
        description={
          provider
            ? `Provider: ${provider.name} · ${snapshot?.slices.length ?? 0} slices sampled`
            : undefined
        }
        action={
          provider && (
            <Badge
              style={
                provider.health.status === 'up'
                  ? statusStyles.healthy
                  : provider.health.status === 'down'
                    ? statusStyles.critical
                    : statusStyles.warning
              }
              dot
              pulse={provider.health.status !== 'up'}
            >
              Telemetry {provider.health.status}
            </Badge>
          )
        }
      />

      {/* ---- Simulation controls ---- */}
      {isManager && synthetic && (
        <Card>
          <CardHeader
            title="Network simulation"
            subtitle="Drive the modelled network into contention. Decisions taken as a result are real and audited."
          />
          <CardBody className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="label">Global load</span>
              <div className="flex gap-1">
                {[0.5, 1, 2, 4, 6].map((multiplier) => (
                  <button
                    key={multiplier}
                    onClick={() => setLoad.mutate(multiplier)}
                    disabled={setLoad.isPending}
                    className={
                      Math.abs(synthetic.globalLoadMultiplier - multiplier) < 0.01
                        ? 'rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-white'
                        : 'rounded-md border border-edge-strong px-2.5 py-1 text-xs text-content-muted transition-colors hover:bg-surface-sunken hover:text-content'
                    }
                  >
                    {multiplier}×
                  </button>
                ))}
              </div>
            </div>

            {selected && (
              <div className="flex items-center gap-2">
                <span className="label">Inject fault into {selected.slice.name}</span>
                <div className="flex gap-1">
                  {(['DEMAND_SURGE', 'LINK_DEGRADATION', 'COMPUTE_SATURATION'] as const).map(
                    (kind) => (
                      <Button
                        key={kind}
                        size="sm"
                        loading={injectFault.isPending}
                        onClick={() => injectFault.mutate({ sliceId: selected.slice.id, kind })}
                      >
                        {humanise(kind)}
                      </Button>
                    ),
                  )}
                </div>
              </div>
            )}

            {synthetic.activeFaults.length > 0 && (
              <Badge style={statusStyles.warning} dot pulse>
                {synthetic.activeFaults.length} active fault(s)
              </Badge>
            )}
          </CardBody>
        </Card>
      )}

      {merged.length === 0 ? (
        <Card>
          <EmptyState title="No slices to monitor" description="Create a slice to begin." />
        </Card>
      ) : (
        <>
          {/* ---- Slice selector ---- */}
          <div className="flex flex-wrap gap-2">
            {merged.map((entry) => {
              const health = entry.live?.health ?? entry.slice.health;
              const active = entry.slice.id === selected?.slice.id;
              return (
                <button
                  key={entry.slice.id}
                  onClick={() => setSelectedId(entry.slice.id)}
                  className={
                    active
                      ? 'rounded-lg border border-brand bg-brand/10 px-3 py-1.5 text-xs font-medium text-brand'
                      : 'rounded-lg border border-edge px-3 py-1.5 text-xs text-content-muted transition-colors hover:border-edge-strong hover:text-content'
                  }
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${healthStyle(health).text.replace('text-', 'bg-')}`}
                    />
                    {entry.slice.name}
                  </span>
                </button>
              );
            })}
          </div>

          {selected && (
            <>
              <div className="grid gap-6 lg:grid-cols-3">
                <div className="lg:col-span-1">
                  <SliceCard entry={selected} />
                </div>

                <Card className="lg:col-span-2">
                  <CardHeader
                    title="Throughput"
                    subtitle="Demand is independent of allocation — the gap between them is the contention signal"
                  />
                  <CardBody className="pt-2">
                    {throughput.length < 2 ? (
                      <div className="grid h-[180px] place-items-center text-xs text-content-muted">
                        Collecting samples…
                      </div>
                    ) : (
                      <MetricChart
                        data={throughput}
                        height={180}
                        yFormatter={(value) => formatBandwidth(value, 0)}
                        series={[
                          { key: 'demand', colour: 'rgb(var(--critical))' },
                          { key: 'allocated', colour: 'rgb(var(--warning))' },
                          { key: 'used', colour: 'rgb(var(--brand))' },
                        ]}
                      />
                    )}
                  </CardBody>
                </Card>
              </div>

              <div className="grid gap-6 lg:grid-cols-3">
                <Card>
                  <CardHeader
                    title="Latency & jitter"
                    subtitle={`SLA: ≤ ${formatLatency(selected.slice.slaTargets.maxLatencyMs)} / ${formatLatency(selected.slice.slaTargets.maxJitterMs)}`}
                  />
                  <CardBody className="pt-2">
                    <MetricChart
                      data={quality}
                      height={150}
                      yFormatter={(value) => `${value.toFixed(1)}ms`}
                      series={[
                        { key: 'latency', colour: 'rgb(var(--degraded))' },
                        { key: 'jitter', colour: 'rgb(var(--info))' },
                      ]}
                    />
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader
                    title="Packet loss"
                    subtitle={`SLA: ≤ ${formatPercent(selected.slice.slaTargets.maxPacketLossPercent, 2)}`}
                  />
                  <CardBody className="pt-2">
                    <MetricChart
                      data={lossSeries}
                      height={150}
                      yFormatter={(value) => `${value.toFixed(2)}%`}
                      series={[{ key: 'loss', colour: 'rgb(var(--critical))' }]}
                    />
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader title="Compute" subtitle="User-plane function utilisation" />
                  <CardBody className="pt-2">
                    <MetricChart
                      data={compute}
                      height={150}
                      yFormatter={(value) => `${value.toFixed(0)}%`}
                      series={[
                        { key: 'cpu', colour: 'rgb(var(--brand))' },
                        { key: 'memory', colour: 'rgb(var(--healthy))' },
                      ]}
                    />
                  </CardBody>
                </Card>
              </div>

              {/* ---- SLA breaches ---- */}
              {live && live.breaches.length > 0 && (
                <Card>
                  <CardHeader title="Active SLA breaches" />
                  <CardBody className="flex flex-wrap gap-2">
                    {live.breaches.map((breach) => (
                      <Tooltip
                        key={breach}
                        content={`This dimension is currently outside the contractual target. SLA scoring takes the WORST dimension, not an average, so a single breach determines the slice's health.`}
                      >
                        <Badge style={statusStyles.critical} dot>
                          {humanise(breach)}
                        </Badge>
                      </Tooltip>
                    ))}
                  </CardBody>
                </Card>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
