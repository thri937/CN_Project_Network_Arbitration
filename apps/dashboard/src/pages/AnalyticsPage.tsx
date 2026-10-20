import { useQuery } from '@tanstack/react-query';
import { capacityApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import { useMergedSlices } from '@/hooks/useLiveData';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LoadingState,
  Metric,
  PageHeader,
  Table,
  Td,
  Th,
  Tooltip,
} from '@/components/ui';
import { CapacityChart } from '@/components/charts/LiveChart';
import { formatBandwidth, formatDuration, formatPercent, humanise } from '@/lib/format';

/**
 * Analytics.
 *
 * Historical capacity from the persisted snapshots, plus per-slice degradation burden.
 *
 * The burden table is the interesting one: it is the raw material the fairness term reads,
 * so it lets an operator verify that the platform is genuinely rotating degradation rather
 * than repeatedly picking the same victim. That claim is easy to make and, without this
 * table, impossible to check.
 */
export function AnalyticsPage(): JSX.Element {
  const { merged, isLoading: slicesLoading } = useMergedSlices();

  const { data: series, isLoading } = useQuery({
    queryKey: queryKeys.capacity.series(),
    queryFn: () => capacityApi.series({ limit: 500 }),
    refetchInterval: 60_000,
  });

  if (isLoading || slicesLoading) return <LoadingState label="Loading analytics" />;

  const chartData = (series?.samples ?? []).map((sample) => ({
    t: sample.atMs,
    demand: sample.demandMbps,
    used: sample.usedMbps,
    allocated: sample.allocatedMbps,
  }));

  const withHistory = merged
    .filter((entry) => entry.slice.degradationHistory.totalEvents > 0)
    .sort((a, b) => b.slice.degradationHistory.burdenScore - a.slice.degradationHistory.burdenScore);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="Historical capacity and the degradation burden that drives the fairness correction."
      />

      {/* ---- Capacity summary ---- */}
      {series?.summary && (
        <Card>
          <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Peak delivered"
              value={formatPercent(series.summary.peakUtilisation * 100, 1)}
              hint="of offered capacity"
            />
            <Metric
              label="Mean delivered"
              value={formatPercent(series.summary.meanUtilisation * 100, 1)}
            />
            <Metric
              label="Peak demand"
              value={formatPercent(series.summary.peakDemandRatio * 100, 0)}
              accent={series.summary.peakDemandRatio > 1 ? 'text-critical' : undefined}
            />
            <Tooltip content="Proportion of measured samples in which total demand exceeded offered capacity. A sustained figure here is an argument for buying transport.">
              <div className="w-full">
                <Metric
                  label="Time oversubscribed"
                  value={formatPercent(series.summary.oversubscribedPercent, 1)}
                  hint={`${series.summary.oversubscribedSamples} of ${series.points} samples`}
                  accent={series.summary.oversubscribedPercent > 10 ? 'text-warning' : undefined}
                />
              </div>
            </Tooltip>
          </CardBody>
        </Card>
      )}

      {/* ---- Historical capacity ---- */}
      <Card>
        <CardHeader
          title="Capacity history"
          subtitle="Persisted snapshots — coarser than the live chart, retained far longer"
        />
        <CardBody className="pt-2">
          {chartData.length < 2 ? (
            <EmptyState
              title="Not enough history yet"
              description="Capacity snapshots are persisted periodically. Leave the platform running to build a series."
            />
          ) : (
            <CapacityChart
              data={chartData}
              capacityMbps={series?.samples[0]?.offeredCapacityMbps ?? 0}
              height={260}
            />
          )}
        </CardBody>
      </Card>

      {/* ---- Degradation burden ---- */}
      <Card>
        <CardHeader
          title="Degradation burden"
          subtitle="Σ (degradation depth × seconds held). The arbitration engine reads this to rotate the burden across slices."
        />
        {withHistory.length === 0 ? (
          <EmptyState
            title="No degradation history"
            description="No slice has been degraded yet, so every slice is equally eligible."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Slice</Th>
                <Th>Department</Th>
                <Th align="right">Events</Th>
                <Th align="right">Total time degraded</Th>
                <Th align="right">Burden score</Th>
                <Th align="right">Fairness effect</Th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Mean over slices WITH history — the same basis the engine uses, so the
                // multiplier shown here matches the one it applies.
                const mean =
                  withHistory.reduce((sum, e) => sum + e.slice.degradationHistory.burdenScore, 0) /
                  withHistory.length;

                return withHistory.map(({ slice, department }) => {
                  const relative = mean > 0 ? slice.degradationHistory.burdenScore / mean : 1;
                  const cheaper = relative < 0.95;
                  const dearer = relative > 1.05;

                  return (
                    <tr key={slice.id}>
                      <Td className="font-medium">{slice.name}</Td>
                      <Td className="text-content-muted">{department?.name ?? '—'}</Td>
                      <Td align="right">{slice.degradationHistory.totalEvents}</Td>
                      <Td align="right" className="text-content-muted">
                        {formatDuration(slice.degradationHistory.cumulativeDegradedSeconds)}
                      </Td>
                      <Td align="right">{slice.degradationHistory.burdenScore.toFixed(1)}</Td>
                      <Td align="right">
                        <Tooltip
                          content={
                            cheaper
                              ? 'Below the fleet average, so this slice is currently a cheaper choice for the optimiser — the burden is rotating toward it.'
                              : dearer
                                ? 'Above the fleet average, so this slice is currently more expensive to degrade and the optimiser will prefer others.'
                                : 'At the fleet average — no fairness adjustment either way.'
                          }
                        >
                          <span
                            className={
                              cheaper
                                ? 'cursor-help text-warning'
                                : dearer
                                  ? 'cursor-help text-healthy'
                                  : 'cursor-help text-content-muted'
                            }
                          >
                            {relative.toFixed(2)}× {cheaper ? 'more likely' : dearer ? 'protected' : 'neutral'}
                          </span>
                        </Tooltip>
                      </Td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Current allocation ---- */}
      <Card>
        <CardHeader title="Current allocation by slice" />
        <Table>
          <thead>
            <tr>
              <Th>Slice</Th>
              <Th>Status</Th>
              <Th align="right">Baseline</Th>
              <Th align="right">Allocated</Th>
              <Th align="right">Demand</Th>
              <Th align="right">Delivered</Th>
              <Th align="right">SLA stress</Th>
            </tr>
          </thead>
          <tbody>
            {merged.map(({ slice, live }) => (
              <tr key={slice.id}>
                <Td className="font-medium">{slice.name}</Td>
                <Td className="text-content-muted">{humanise(slice.status)}</Td>
                <Td align="right" className="text-content-muted">
                  {formatBandwidth(slice.baselineAllocatedMbps)}
                </Td>
                <Td align="right" className={slice.status === 'DEGRADED' ? 'text-critical' : ''}>
                  {formatBandwidth(slice.allocatedMbps)}
                </Td>
                <Td align="right">{live ? formatBandwidth(live.demandMbps) : '—'}</Td>
                <Td align="right">{live ? formatBandwidth(live.usedMbps) : '—'}</Td>
                <Td align="right">
                  {live ? (
                    <span
                      className={
                        live.slaStress > 0.85
                          ? 'text-critical'
                          : live.slaStress > 0.6
                            ? 'text-warning'
                            : 'text-content-muted'
                      }
                    >
                      {formatPercent(live.slaStress * 100, 0)}
                    </span>
                  ) : (
                    '—'
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
