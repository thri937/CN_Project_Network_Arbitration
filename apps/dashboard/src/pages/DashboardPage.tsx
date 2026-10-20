import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { arbitrationApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import {
  useCapacity,
  useCapacitySeries,
  useContention,
  useMergedSlices,
} from '@/hooks/useLiveData';
import {
  Badge,
  Bar,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LoadingState,
  Metric,
  PageHeader,
  Tooltip,
} from '@/components/ui';
import { SliceCard } from '@/components/SliceCard';
import { NetworkTopology } from '@/components/NetworkTopology';
import { CapacityChart } from '@/components/charts/LiveChart';
import { Icons } from '@/components/layout/Icons';
import { cn } from '@/lib/cn';
import {
  capacityLevelStyle,
  dispositionStyle,
  formatBandwidth,
  formatPercent,
  formatRelative,
  humanise,
  severityStyle,
  statusStyles,
} from '@/lib/format';

/**
 * Network Operations Centre dashboard.
 *
 * LAYOUT REFLECTS THE QUESTIONS AN OPERATOR ASKS, IN ORDER:
 *   1. Is the network in trouble?           → capacity strip, contention banner
 *   2. How did we get here?                 → capacity chart with the demand/capacity crossing
 *   3. What is the system doing about it?   → live arbitration feed
 *   4. Which slices are affected?           → live slice cards
 *   5. How does it all connect?             → topology
 *
 * Everything above the fold answers question 1 without scrolling.
 */
export function DashboardPage(): JSX.Element {
  const { data: capacityData, isLoading: capacityLoading } = useCapacity();
  const { data: contentionData } = useContention();
  const { merged, snapshot, stale, isLoading: slicesLoading } = useMergedSlices();
  const series = useCapacitySeries(150);

  const { data: recentDecisions } = useQuery({
    queryKey: queryKeys.arbitration.recent(),
    queryFn: arbitrationApi.recent,
    refetchInterval: 15_000,
  });

  const capacity = capacityData?.capacity ?? null;
  const contention = contentionData?.event ?? null;

  if (capacityLoading && slicesLoading) return <LoadingState label="Connecting to the network" />;

  const degradedSlices = merged.filter((entry) => entry.slice.status === 'DEGRADED');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Network Operations"
        description={
          snapshot
            ? `${merged.length} slices across ${new Set(merged.map((m) => m.slice.departmentId)).size} departments · updated ${formatRelative(snapshot.atMs)}`
            : 'Waiting for the first telemetry sample'
        }
        action={
          stale && (
            <Badge style={statusStyles.warning} dot pulse>
              Telemetry stale
            </Badge>
          )
        }
      />

      {/* ---- 1. Is the network in trouble? ---- */}
      {contention && <ContentionBanner event={contention} gate={contentionData?.arbitration ?? null} />}

      <CapacityStrip capacity={capacity} degradedCount={degradedSlices.length} />

      {/* ---- 2. How did we get here? ---- */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Capacity over time"
            subtitle="Demand can exceed capacity — that crossing is the contention signal"
          />
          <CardBody className="pt-2">
            {series.length < 2 ? (
              <div className="grid h-[200px] place-items-center text-xs text-content-muted">
                Collecting samples…
              </div>
            ) : (
              <CapacityChart
                data={series}
                capacityMbps={capacity?.offeredCapacityMbps ?? 0}
                height={200}
              />
            )}
          </CardBody>
        </Card>

        {/* ---- 3. What is the system doing? ---- */}
        <Card>
          <CardHeader
            title="Arbitration feed"
            action={
              <Link to="/arbitration" className="text-xs font-medium text-brand hover:underline">
                All decisions
              </Link>
            }
          />
          <CardBody className="max-h-[248px] overflow-y-auto p-0">
            {!recentDecisions || recentDecisions.length === 0 ? (
              <EmptyState
                title="No decisions yet"
                description="Arbitration runs when demand exceeds capacity."
              />
            ) : (
              <ul className="divide-y divide-edge/60">
                {recentDecisions.slice(0, 8).map((decision) => (
                  <li key={decision.id}>
                    <Link
                      to={`/arbitration/${decision.id}`}
                      className="block px-4 py-2.5 transition-colors hover:bg-surface-sunken"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-content">
                          {decision.degradedSliceIds.length === 0
                            ? 'No degradation required'
                            : `${decision.degradedSliceIds.length} slice(s) degraded`}
                        </span>
                        <Badge
                          style={
                            decision.outcome === 'RESOLVED'
                              ? statusStyles.healthy
                              : decision.outcome === 'ESCALATED'
                                ? statusStyles.critical
                                : statusStyles.warning
                          }
                          className="text-[10px]"
                        >
                          {decision.outcome}
                        </Badge>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-content-muted">
                        <span className="tabular">
                          freed {formatBandwidth(decision.achievedReductionMbps)}
                        </span>
                        <span className="text-content-subtle">·</span>
                        <span className="tabular">
                          {formatPercent(decision.confidence * 100, 0)} confidence
                        </span>
                        <span className="ml-auto text-content-subtle tabular">
                          {formatRelative(decision.decidedAtMs)}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* ---- 4. Which slices are affected? ---- */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-content">
            Live slices
            {degradedSlices.length > 0 && (
              <span className="ml-2 text-xs font-normal text-critical">
                {degradedSlices.length} degraded
              </span>
            )}
          </h2>
          <Link to="/slices" className="text-xs font-medium text-brand hover:underline">
            Manage slices
          </Link>
        </div>

        {merged.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Icons.slices className="h-8 w-8" />}
              title="No slices configured"
              description="Create a department and a slice to begin monitoring."
            />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {merged.map((entry) => (
              <SliceCard key={entry.slice.id} entry={entry} />
            ))}
          </div>
        )}
      </section>

      {/* ---- 5. How does it connect? ---- */}
      <Card>
        <CardHeader
          title="Network topology"
          subtitle="Link width shows committed bandwidth; flow stops when a department is starved"
        />
        <CardBody>
          <NetworkTopology entries={merged} />
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CapacityStrip({
  capacity,
  degradedCount,
}: {
  capacity: ReturnType<typeof useCapacity>['data'] extends infer T
    ? T extends { capacity: infer C }
      ? C
      : never
    : never;
  degradedCount: number;
}) {
  if (!capacity) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-content-muted">Waiting for the first capacity measurement…</p>
        </CardBody>
      </Card>
    );
  }

  const level = capacityLevelStyle(capacity.level);
  const utilisationPercent = capacity.utilisation * 100;
  const demandPercent = capacity.demandRatio * 100;

  return (
    <Card>
      <CardBody className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Total capacity"
          value={formatBandwidth(capacity.totalCapacityMbps)}
          hint={`${formatBandwidth(capacity.reservedCapacityMbps)} reserved for signalling`}
        />

        <Metric
          label="Allocated"
          value={formatBandwidth(capacity.allocatedMbps)}
          hint={
            <span className={capacity.availableMbps < 0 ? 'text-critical' : undefined}>
              {capacity.availableMbps >= 0
                ? `${formatBandwidth(capacity.availableMbps)} available`
                : `${formatBandwidth(Math.abs(capacity.availableMbps))} oversubscribed`}
            </span>
          }
        />

        <Tooltip
          content={
            <>
              <strong>Delivered</strong> is what is actually flowing. It can never exceed the
              allocation, so it saturates at 100 % — which is why it cannot, on its own, tell
              you how badly the network is contended.
            </>
          }
        >
          <div className="w-full">
            <Metric
              label="Delivered"
              value={formatPercent(utilisationPercent, 0)}
              hint={formatBandwidth(capacity.usedMbps)}
              accent={utilisationPercent > 95 ? 'text-degraded' : undefined}
            />
            <Bar
              percent={utilisationPercent}
              colourClass={utilisationPercent > 95 ? 'bg-degraded' : 'bg-brand'}
              className="mt-2 h-1.5"
            />
          </div>
        </Tooltip>

        <Tooltip
          content={
            <>
              <strong>Demand</strong> is what slices are asking for. Unlike delivered
              throughput it is unbounded, so it is the only signal that distinguishes
              &ldquo;full&rdquo; from &ldquo;badly oversubscribed&rdquo;. Above 100 %, arbitration
              is required.
            </>
          }
        >
          <div className="w-full">
            <Metric
              label="Demand"
              value={formatPercent(demandPercent, 0)}
              hint={
                capacity.oversubscribed
                  ? `${formatBandwidth(capacity.excessDemandMbps)} beyond capacity`
                  : formatBandwidth(capacity.demandMbps)
              }
              accent={capacity.oversubscribed ? 'text-critical' : undefined}
            />
            <Bar
              percent={Math.min(100, demandPercent)}
              overflowPercent={Math.max(0, demandPercent - 100)}
              colourClass={capacity.oversubscribed ? 'bg-critical' : 'bg-healthy'}
              className="mt-2 h-1.5"
            />
          </div>
        </Tooltip>
      </CardBody>

      <div className="flex flex-wrap items-center gap-3 border-t border-edge px-5 py-3">
        <Badge style={level} dot pulse={capacity.oversubscribed}>
          {humanise(capacity.level)}
        </Badge>
        <span className="text-xs text-content-muted">
          {capacity.activeSliceCount} active slices
        </span>
        {degradedCount > 0 && (
          <Badge style={statusStyles.critical}>{degradedCount} degraded</Badge>
        )}
        {capacity.breachingSliceCount > 0 && (
          <Badge style={statusStyles.warning}>{capacity.breachingSliceCount} breaching SLA</Badge>
        )}
        {capacity.projectedUtilisation !== null && (
          <Tooltip content="Least-squares projection of delivered throughput one trend window ahead.">
            <span className="ml-auto text-xs text-content-subtle tabular">
              trend → {formatPercent(capacity.projectedUtilisation * 100, 0)}
            </span>
          </Tooltip>
        )}
      </div>
    </Card>
  );
}

/**
 * Contention banner.
 *
 * Deliberately loud and always at the top. It also explains WHY arbitration has not yet run
 * when a gate is blocking it — otherwise an operator watching a red banner with no action
 * concludes the platform is broken, when it is in fact waiting out a cooldown so a plan it
 * already applied can take effect.
 */
function ContentionBanner({
  event,
  gate,
}: {
  event: NonNullable<ReturnType<typeof useContention>['data']>['event'];
  gate: { allowed: boolean; reason?: string; waitSeconds?: number } | null;
}) {
  if (!event) return null;

  const severity = severityStyle(event.severity);

  return (
    <div
      className={cn(
        'rounded-xl border px-5 py-4',
        severity.bg,
        severity.border,
        'animate-slide-up',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex gap-3">
          <div className={cn('mt-0.5 shrink-0', severity.text)}>
            <Icons.contention className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className={cn('text-sm font-semibold', severity.text)}>
                Network contention — {humanise(event.severity)}
              </h2>
              <Badge style={severity} className="text-[10px]">
                {humanise(event.status)}
              </Badge>
            </div>

            <p className="mt-1 text-xs leading-relaxed text-content-muted">
              Demand is at{' '}
              <span className="tabular font-medium text-content">
                {formatPercent(event.currentDemandRatio * 100, 0)}
              </span>{' '}
              of offered capacity — {formatBandwidth(event.currentExcessMbps)} beyond what the
              network can carry. Peak this event:{' '}
              <span className="tabular">{formatPercent(event.peakDemandRatio * 100, 0)}</span>.
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-content-muted">
              <span>Detected {formatRelative(event.detectedAtMs)}</span>
              <span className="text-content-subtle">·</span>
              <span>
                {event.arbitrationCount} arbitration pass
                {event.arbitrationCount === 1 ? '' : 'es'}
              </span>
              {gate && !gate.allowed && (
                <>
                  <span className="text-content-subtle">·</span>
                  <span className="text-warning">
                    {gate.reason}
                    {gate.waitSeconds !== undefined && ` (${gate.waitSeconds}s)`}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <Link
          to="/contention"
          className={cn(
            'shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
            severity.border,
            severity.text,
            'hover:bg-surface-raised',
          )}
        >
          Investigate
        </Link>
      </div>

      {event.unresolvableReason && (
        <div className="mt-3 rounded-lg border border-critical/30 bg-critical/10 px-3 py-2">
          <p className="text-xs font-medium text-critical">Cannot be resolved automatically</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-content-muted">
            {event.unresolvableReason}
          </p>
        </div>
      )}
    </div>
  );
}

export { dispositionStyle };
