import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { arbitrationApi, contentionApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import { useContention } from '@/hooks/useLiveData';
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
  Table,
  Td,
  Th,
  Tooltip,
} from '@/components/ui';
import { Icons } from '@/components/layout/Icons';
import {
  formatBandwidth,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  humanise,
  severityStyle,
  statusStyles,
} from '@/lib/format';

/**
 * Contention events.
 *
 * An event is a stateful entity, not a log line, and this page shows the difference: how
 * long it has been running, how bad it got, how many arbitration passes it has had, and why
 * the next one has not started yet.
 */
export function ContentionPage(): JSX.Element {
  const { data: current } = useContention();

  const { data: history, isLoading } = useQuery({
    queryKey: queryKeys.contention.list(),
    queryFn: () => contentionApi.list({ limit: 50 }),
    refetchInterval: 20_000,
  });

  const openEvent = current?.event ?? null;

  const { data: decisions } = useQuery({
    queryKey: queryKeys.arbitration.forContention(openEvent?.id ?? ''),
    queryFn: () => arbitrationApi.forContention(openEvent!.id),
    enabled: Boolean(openEvent),
  });

  if (isLoading) return <LoadingState label="Loading contention events" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contention"
        description="A contention event opens when total demand stays above 102 % of the 950 kbps link for two samples (4 s), and closes after three normal samples."
      />

      {/* ---- Detector configuration ---- */}
      {current?.detector && (
        <Card>
          <CardHeader
            title="Detector"
            subtitle="So that a short spike never causes a cut"
          />
          <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Tooltip content="Demand must exceed capacity by this margin before contention is even suspected. Absorbs measurement jitter around the capacity line.">
              <div className="w-full">
                <Metric
                  label="Detection threshold"
                  value={formatPercent(current.detector.detectionThresholdRatio * 100, 0)}
                  hint="of offered capacity"
                />
              </div>
            </Tooltip>
            <Tooltip content="Consecutive above-threshold samples required to open an event. One noisy sample must never degrade anyone's bandwidth.">
              <div className="w-full">
                <Metric
                  label="Confirmation"
                  value={current.detector.confirmationSamples}
                  hint="consecutive samples"
                />
              </div>
            </Tooltip>
            <Tooltip content="Consecutive below-threshold samples required to close an event. Deliberately higher than confirmation — closing early re-opens on the next noisy tick.">
              <div className="w-full">
                <Metric
                  label="Clearance"
                  value={current.detector.clearanceSamples}
                  hint="consecutive samples"
                />
              </div>
            </Tooltip>
            <Tooltip content="Minimum interval between arbitration passes, so an applied plan has time to take effect before being judged.">
              <div className="w-full">
                <Metric
                  label="Arbitration cooldown"
                  value={`${current.detector.arbitrationCooldownSeconds}s`}
                />
              </div>
            </Tooltip>
          </CardBody>
        </Card>
      )}

      {/* ---- Open event ---- */}
      {openEvent ? (
        <Card className="border-critical/40">
          <CardHeader
            title="Open contention"
            subtitle={`Detected ${formatRelative(openEvent.detectedAtMs)}`}
            action={
              <div className="flex items-center gap-2">
                <Badge style={severityStyle(openEvent.severity)} dot pulse>
                  {humanise(openEvent.severity)}
                </Badge>
                <Badge style={statusStyles.warning}>{humanise(openEvent.status)}</Badge>
              </div>
            }
          />

          <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Current demand"
              value={formatPercent(openEvent.currentDemandRatio * 100, 0)}
              hint={`${formatBandwidth(openEvent.currentExcessMbps)} beyond capacity`}
              accent="text-critical"
            />
            <Metric
              label="Peak this event"
              value={formatPercent(openEvent.peakDemandRatio * 100, 0)}
              hint={`${formatBandwidth(openEvent.peakExcessMbps)} at worst`}
            />
            <Metric
              label="Arbitration passes"
              value={openEvent.arbitrationCount}
              hint={
                openEvent.lastArbitrationAt
                  ? `last ${formatRelative(openEvent.lastArbitrationAt)}`
                  : 'none yet'
              }
            />
            <div>
              <div className="label">Clearance progress</div>
              <div className="mt-1.5">
                <Bar
                  percent={
                    current?.detector
                      ? (openEvent.clearanceProgress / current.detector.clearanceSamples) * 100
                      : 0
                  }
                  colourClass="bg-healthy"
                  className="h-2"
                />
                <p className="mt-1.5 text-[11px] text-content-muted">
                  {openEvent.clearanceProgress} of {current?.detector.clearanceSamples ?? '?'}{' '}
                  quiet samples
                </p>
              </div>
            </div>
          </CardBody>

          {current?.arbitration && !current.arbitration.allowed && (
            <div className="border-t border-edge px-5 py-3">
              <p className="text-xs text-warning">
                <span className="font-medium">Arbitration held:</span> {current.arbitration.reason}
                {current.arbitration.waitSeconds !== undefined &&
                  ` — ${current.arbitration.waitSeconds}s remaining`}
              </p>
            </div>
          )}

          {openEvent.unresolvableReason && (
            <div className="border-t border-edge px-5 py-3">
              <p className="text-xs font-medium text-critical">Cannot be resolved automatically</p>
              <p className="mt-1 text-[11px] leading-relaxed text-content-muted">
                {openEvent.unresolvableReason}
              </p>
            </div>
          )}

          {/* Participants */}
          <div className="border-t border-edge">
            <div className="px-5 py-3">
              <h3 className="text-xs font-semibold text-content">
                Contributing slices at detection
              </h3>
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Slice</Th>
                  <Th align="right">Demand</Th>
                  <Th align="right">Allocated</Th>
                  <Th align="right">Share of demand</Th>
                </tr>
              </thead>
              <tbody>
                {openEvent.participants.slice(0, 10).map((participant) => (
                  <tr key={participant.sliceId}>
                    <Td className="font-medium">{participant.sliceCode}</Td>
                    <Td align="right">{formatBandwidth(participant.demandMbps)}</Td>
                    <Td align="right" className="text-content-muted">
                      {formatBandwidth(participant.allocatedMbps)}
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-2">
                        <Bar
                          percent={participant.demandShare * 100}
                          colourClass="bg-brand"
                          className="h-1.5 w-16"
                        />
                        <span className="w-10 text-right">
                          {formatPercent(participant.demandShare * 100, 0)}
                        </span>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>

          {/* Decisions for this event */}
          {decisions && decisions.length > 0 && (
            <div className="border-t border-edge px-5 py-4">
              <h3 className="mb-2 text-xs font-semibold text-content">Arbitration passes</h3>
              <ul className="space-y-1.5">
                {decisions.map((decision) => (
                  <li key={decision.id}>
                    <Link
                      to={`/arbitration/${decision.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2 text-xs transition-colors hover:bg-surface-sunken"
                    >
                      <span className="text-content">
                        {formatDateTime(decision.decidedAt)} · freed{' '}
                        {formatBandwidth(decision.achievedReductionMbps)}
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge
                          style={
                            decision.outcome === 'RESOLVED'
                              ? statusStyles.healthy
                              : statusStyles.warning
                          }
                          className="text-[10px]"
                        >
                          {decision.outcome}
                        </Badge>
                        <Icons.chevronRight className="h-3 w-3 text-content-subtle" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon={<Icons.check className="h-8 w-8 text-healthy" />}
            title="No contention"
            description="Total demand fits the link. Run TC3 on the testbed page to cause one."
          />
        </Card>
      )}

      {/* ---- History ---- */}
      <Card>
        <CardHeader title="History" />
        {!history || history.items.length === 0 ? (
          <EmptyState title="No past contention events" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Detected</Th>
                <Th>Severity</Th>
                <Th>Status</Th>
                <Th align="right">Peak demand</Th>
                <Th align="right">Peak excess</Th>
                <Th align="right">Duration</Th>
                <Th align="right">Passes</Th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((event) => (
                <tr key={event.id} className="transition-colors hover:bg-surface-sunken">
                  <Td className="text-content-muted">{formatDateTime(event.detectedAt)}</Td>
                  <Td>
                    <Badge style={severityStyle(event.severity)} className="text-[10px]">
                      {humanise(event.severity)}
                    </Badge>
                  </Td>
                  <Td>
                    <Badge
                      style={
                        event.status === 'RESOLVED'
                          ? statusStyles.healthy
                          : event.status === 'UNRESOLVABLE'
                            ? statusStyles.critical
                            : statusStyles.warning
                      }
                      className="text-[10px]"
                    >
                      {humanise(event.status)}
                    </Badge>
                  </Td>
                  <Td align="right">{formatPercent(event.peakDemandRatio * 100, 0)}</Td>
                  <Td align="right">{formatBandwidth(event.peakExcessMbps)}</Td>
                  <Td align="right" className="text-content-muted">
                    {event.durationSeconds !== undefined
                      ? formatDuration(event.durationSeconds)
                      : 'ongoing'}
                  </Td>
                  <Td align="right">{event.arbitrationCount}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
