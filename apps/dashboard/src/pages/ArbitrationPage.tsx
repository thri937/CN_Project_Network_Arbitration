import { useState } from 'react';
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
  dispositionStyle,
  formatBandwidth,
  formatDateTime,
  formatPercent,
  formatRelative,
  humanise,
  scoreStyle,
  statusStyles,
} from '@/lib/format';
import type { ArbitrationPlan } from '@/types/api';

/**
 * Arbitration decisions.
 *
 * The simulate button is the important control here. It computes a plan against live
 * telemetry WITHOUT applying it, so an operator can answer "what would this system do right
 * now?" before trusting it to act unattended. An automated control loop nobody can
 * interrogate is one that gets switched off after its first surprising decision.
 */
export function ArbitrationPage(): JSX.Element {
  const { isManager } = useAuth();
  const queryClient = useQueryClient();
  const { data: contention } = useContention();

  const [plan, setPlan] = useState<ArbitrationPlan | null>(null);

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

  const simulate = useMutation({
    mutationFn: () => arbitrationApi.simulate(),
    onSuccess: (result) => setPlan(result.plan),
  });

  const trigger = useMutation({
    mutationFn: () => arbitrationApi.trigger(false),
    onSuccess: () => {
      setPlan(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.arbitration.all() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.slices.all() });
    },
  });

  if (isLoading) return <LoadingState label="Loading decisions" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Arbitration Decisions"
        description="Every decision is permanent, explainable and reversible."
        action={
          isManager && (
            <div className="flex items-center gap-2">
              <Button size="sm" loading={simulate.isPending} onClick={() => simulate.mutate()}>
                Simulate
              </Button>
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

      {(simulate.error || trigger.error) && (
        <div className="rounded-lg border border-critical/30 bg-critical/10 px-4 py-3">
          <p className="text-xs text-critical">
            {[simulate.error, trigger.error]
              .filter((e): e is ApiError => e instanceof ApiError)
              .map((e) => e.message)
              .join(' ')}
          </p>
        </div>
      )}

      {/* ---- Simulation result ---- */}
      {plan && (
        <Card className="border-brand/40">
          <CardHeader
            title="Simulated plan — not applied"
            subtitle="What the engine would do against the current network state"
            action={
              <button
                onClick={() => setPlan(null)}
                className="rounded p-1 text-content-muted hover:text-content"
                aria-label="Dismiss simulation"
              >
                <Icons.close className="h-4 w-4" />
              </button>
            }
          />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-4">
              <Metric label="Verdict" value={plan.verdict} />
              <Metric
                label="Would free"
                value={formatBandwidth(plan.achievedReductionMbps)}
                hint={`of ${formatBandwidth(plan.requiredReductionMbps)} needed`}
              />
              <Metric label="Confidence" value={formatPercent(plan.confidence * 100, 0)} />
              <Metric
                label="Slices degraded"
                value={plan.allocations.filter((a) => a.disposition === 'DEGRADED').length}
              />
            </div>

            <p className="text-xs leading-relaxed text-content-muted">{plan.rationale}</p>

            <Table>
              <thead>
                <tr>
                  <Th>Slice</Th>
                  <Th>Disposition</Th>
                  <Th align="right">Score</Th>
                  <Th align="right">Would change</Th>
                </tr>
              </thead>
              <tbody>
                {plan.allocations
                  .slice()
                  .sort((a, b) => b.reductionMbps - a.reductionMbps)
                  .map((allocation) => (
                    <tr key={allocation.sliceId}>
                      <Td className="font-medium">{allocation.sliceName}</Td>
                      <Td>
                        <Badge style={dispositionStyle(allocation.disposition)} className="text-[10px]">
                          {allocation.disposition}
                        </Badge>
                      </Td>
                      <Td align="right">{allocation.businessScore.toFixed(1)}</Td>
                      <Td align="right">
                        {allocation.reductionMbps > 0.01 ? (
                          <span className="text-critical">
                            −{formatPercent(allocation.degradationPercent, 1)}
                          </span>
                        ) : (
                          <span className="text-content-subtle">—</span>
                        )}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
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
