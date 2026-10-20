import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { arbitrationApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/auth/AuthProvider';
import { useContention } from '@/hooks/useLiveData';
import { ApiError } from '@/api/client';
import {
  Badge,
  Button,
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
  formatPercent,
  formatRelative,
  humanise,
  scoreStyle,
  statusStyles,
} from '@/lib/format';

/**
 * Arbitration decisions.
 *
 * Lists every decision. "Arbitrate now" (managers) runs the engine at once on an open contention.
 */
export function ArbitrationPage(): JSX.Element {
  const { isManager } = useAuth();
  const queryClient = useQueryClient();
  const { data: contention } = useContention();


  const { data: decisions, isLoading } = useQuery({
    queryKey: queryKeys.arbitration.list(),
    queryFn: () => arbitrationApi.list({ limit: 50 }),
    refetchInterval: 20_000,
  });

  const { data: summary } = useQuery({
    queryKey: queryKeys.arbitration.summary(),
    queryFn: () => arbitrationApi.summary(),
    refetchInterval: 60_000,
  });

  const trigger = useMutation({
    mutationFn: () => arbitrationApi.trigger(false),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.arbitration.all() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.slices.all() });
    },
  });

  if (isLoading) return <LoadingState label="Loading decisions" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Decisions"
        description="Each time the link was overloaded: who was cut, by how much, and why. Click a decision for the full explanation."
        action={
          isManager && (
            <div className="flex items-center gap-2">
              {contention?.open && (
                <Tooltip
                  content={
                    contention.arbitration?.allowed
                      ? 'Run arbitration now against the open contention.'
                      : contention.arbitration?.reason
                  }
                >
                  <Button
                    size="sm"
                    variant="primary"
                    loading={trigger.isPending}
                    disabled={!contention.arbitration?.allowed}
                    onClick={() => trigger.mutate()}
                  >
                    Arbitrate now
                  </Button>
                </Tooltip>
              )}
            </div>
          )
        }
      />

      {trigger.error && (
        <div className="rounded-lg border border-critical/30 bg-critical/10 px-4 py-3">
          <p className="text-xs text-critical">
            {[trigger.error]
              .filter((e): e is ApiError => e instanceof ApiError)
              .map((e) => e.message)
              .join(' ')}
          </p>
        </div>
      )}

      {/* ---- Summary ---- */}
      {summary && summary.total > 0 && (
        <Card>
          <CardHeader title="Last 7 days" />
          <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Decisions" value={summary.total} />
            <Metric
              label="Bandwidth freed"
              value={formatBandwidth(summary.totalBandwidthFreedMbps)}
            />
            <Metric
              label="Mean confidence"
              value={formatPercent(summary.meanConfidence * 100, 0)}
            />
            <Tooltip
              content={
                <>
                  Average extra business harm a conventional <strong>priority-sort</strong>{' '}
                  controller would have caused. Computed on every decision by pricing that
                  strategy on the same harm scale as the chosen plan.
                </>
              }
            >
              <div className="w-full">
                <Metric
                  label="Harm avoided vs priority sort"
                  value={formatPercent(summary.harmAvoidedVsPrioritySortPercent, 1)}
                  accent="text-healthy"
                />
              </div>
            </Tooltip>
          </CardBody>
        </Card>
      )}

      {/* ---- Decision history ---- */}
      <Card>
        <CardHeader title="Decision history" />
        {!decisions || decisions.items.length === 0 ? (
          <EmptyState
            icon={<Icons.arbitration className="h-8 w-8" />}
            title="No decisions yet"
            description="Arbitration runs automatically when demand exceeds capacity."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Decided</Th>
                <Th>Outcome</Th>
                <Th>Trigger</Th>
                <Th align="right">Freed</Th>
                <Th align="right">Degraded</Th>
                <Th align="right">Confidence</Th>
                <Th>Recovery</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {decisions.items.map((decision) => (
                <tr key={decision.id} className="transition-colors hover:bg-surface-sunken">
                  <Td className="text-content-muted">
                    <Tooltip content={formatDateTime(decision.decidedAt)}>
                      <span className="cursor-help">{formatRelative(decision.decidedAtMs)}</span>
                    </Tooltip>
                  </Td>
                  <Td>
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
                  </Td>
                  <Td className="text-content-muted">{humanise(decision.trigger)}</Td>
                  <Td align="right">{formatBandwidth(decision.achievedReductionMbps)}</Td>
                  <Td align="right">{decision.degradedSliceIds.length}</Td>
                  <Td align="right">
                    <Badge style={scoreStyle(decision.confidence * 100)} className="text-[10px]">
                      {formatPercent(decision.confidence * 100, 0)}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="text-xs text-content-muted">
                      {humanise(decision.recoveryStatus)}
                    </span>
                  </Td>
                  <Td align="right">
                    <Link
                      to={`/arbitration/${decision.id}`}
                      className="text-xs font-medium text-brand hover:underline"
                    >
                      Explain
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
