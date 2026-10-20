import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { arbitrationApi, auditApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/auth/AuthProvider';
import { ApiError } from '@/api/client';
import {
  Badge,
  Bar,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  LoadingState,
  Metric,
  PageHeader,
  Table,
  Td,
  Th,
  Tooltip,
} from '@/components/ui';
import { Icons } from '@/components/layout/Icons';
import { cn } from '@/lib/cn';
import {
  dispositionStyle,
  formatBandwidth,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  humanise,
  scoreStyle,
  statusStyles,
} from '@/lib/format';
import type { DecisionAllocation, DecisionAlternative } from '@/types/api';

/**
 * Arbitration decision detail.
 *
 * THE MOST IMPORTANT SCREEN IN THE PRODUCT.
 * =========================================
 * Everything else displays state. This page answers the question the platform exists to
 * answer: *why was MY slice degraded and not someone else's?*
 *
 * It is deliberately readable by the affected department head, not only by an engineer.
 * Structure follows how that conversation actually goes:
 *
 *   1. What happened            → outcome, bandwidth freed, confidence
 *   2. Why it was necessary     → the rationale, in prose
 *   3. What happened to whom    → per-slice table, ordered by impact
 *   4. Why THIS slice           → per-slice factor breakdown, on demand
 *   5. What else was considered → counterfactuals, priced on the same scale
 *   6. Under which rules        → the policy snapshot as it stood at the time
 */
export function DecisionDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const { data: decision, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.arbitration.detail(id ?? ''),
    queryFn: () => arbitrationApi.get(id!),
    enabled: Boolean(id),
    // A decision is immutable except for recovery status; no need to poll aggressively.
    staleTime: 10_000,
  });

  const { data: timeline } = useQuery({
    queryKey: queryKeys.audit.timeline(id ?? ''),
    queryFn: () => auditApi.timeline(id!),
    enabled: Boolean(id) && isAdmin,
  });

  const override = useMutation({
    mutationFn: (reason: string) => arbitrationApi.override(id!, reason, true),
    onSuccess: () => {
      setOverrideOpen(false);
      setOverrideReason('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.arbitration.all() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.slices.all() });
    },
  });

  if (isLoading) return <LoadingState label="Loading decision" />;

  if (error || !decision) {
    return (
      <ErrorState
        title="Decision not found"
        message={error instanceof ApiError ? error.message : 'This decision could not be loaded.'}
        {...(error instanceof ApiError && error.correlationId
          ? { correlationId: error.correlationId }
          : {})}
        onRetry={() => void refetch()}
      />
    );
  }

  const degraded = decision.allocations
    .filter((a) => a.disposition === 'DEGRADED')
    .sort((a, b) => b.reductionMbps - a.reductionMbps);
  const exempt = decision.allocations.filter((a) => a.disposition === 'EXEMPT');
  const untouched = decision.allocations.filter(
    (a) => a.disposition === 'PROTECTED' || a.disposition === 'UNAFFECTED',
  );

  const prioritySort = decision.alternatives.find((a) => a.strategy === 'PRIORITY_SORT');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Decision"
        description={
          <span>
            <span className="font-mono text-xs">{decision.id}</span> ·{' '}
            {formatDateTime(decision.decidedAt)}
          </span>
        }
        action={
          <div className="flex items-center gap-2">
            <Link
              to={`/contention`}
              className="rounded-lg border border-edge-strong px-3 py-1.5 text-xs font-medium text-content transition-colors hover:bg-surface-sunken"
            >
              Contention event
            </Link>
            {isAdmin && decision.recoveryStatus !== 'RECOVERED' && !decision.overriddenBy && (
              <Button variant="danger" size="sm" onClick={() => setOverrideOpen(true)}>
                Override
              </Button>
            )}
          </div>
        }
      />

      {decision.overriddenBy && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-5 py-4">
          <p className="text-sm font-semibold text-warning">Overridden by an administrator</p>
          <p className="mt-1 text-xs leading-relaxed text-content-muted">
            {decision.overrideReason}
          </p>
        </div>
      )}

      {/* ---- 1. What happened ---- */}
      <Card>
        <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="label">Outcome</div>
            <div className="mt-1.5 flex items-center gap-2">
              <Badge
                style={
                  decision.outcome === 'RESOLVED'
                    ? statusStyles.healthy
                    : decision.outcome === 'ESCALATED'
                      ? statusStyles.critical
                      : statusStyles.warning
                }
                dot
              >
                {decision.outcome}
              </Badge>
              <span className="text-xs text-content-subtle">{decision.trigger}</span>
            </div>
          </div>

          <Metric
            label="Bandwidth freed"
            value={formatBandwidth(decision.achievedReductionMbps)}
            hint={
              decision.shortfallMbps > 0
                ? `${formatBandwidth(decision.shortfallMbps)} short of the ${formatBandwidth(decision.requiredReductionMbps)} required`
                : `of ${formatBandwidth(decision.requiredReductionMbps)} required`
            }
            accent={decision.shortfallMbps > 0 ? 'text-warning' : undefined}
          />

          <Tooltip
            content={
              <>
                <strong>Confidence</strong> measures how sure the engine is that this is the RIGHT
                plan — not how severe the contention was. It combines the harm margin over the
                runner-up plan, telemetry freshness, data completeness and remaining constraint
                slack.
              </>
            }
          >
            <div className="w-full">
              <Metric
                label="Confidence"
                value={formatPercent(decision.confidence * 100, 0)}
                accent={
                  decision.confidence < 0.4
                    ? 'text-critical'
                    : decision.confidence < 0.65
                      ? 'text-warning'
                      : 'text-healthy'
                }
              />
              <Bar
                percent={decision.confidence * 100}
                colourClass={
                  decision.confidence < 0.4
                    ? 'bg-critical'
                    : decision.confidence < 0.65
                      ? 'bg-warning'
                      : 'bg-healthy'
                }
                className="mt-2 h-1.5"
              />
            </div>
          </Tooltip>

          <div>
            <div className="label">Slices affected</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {degraded.length > 0 && (
                <Badge style={statusStyles.critical}>{degraded.length} degraded</Badge>
              )}
              {exempt.length > 0 && <Badge style={statusStyles.info}>{exempt.length} exempt</Badge>}
              {untouched.length > 0 && (
                <Badge style={statusStyles.healthy}>{untouched.length} protected</Badge>
              )}
            </div>
            <div className="mt-2 text-[11px] text-content-subtle">
              Recovery: {humanise(decision.recoveryStatus)}
              {decision.fullyRecoveredAt && ` · ${formatRelative(decision.fullyRecoveredAt)}`}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ---- 2. Why it was necessary ---- */}
      <Card>
        <CardHeader title="Rationale" subtitle="The engine's account of this decision" />
        <CardBody>
          <p className="text-sm leading-relaxed text-content">{decision.rationale}</p>

          {decision.escalationReason && (
            <div className="mt-4 rounded-lg border border-critical/30 bg-critical/10 px-4 py-3">
              <p className="text-xs font-semibold text-critical">Requires operator attention</p>
              <p className="mt-1 text-xs leading-relaxed text-content-muted">
                {decision.escalationReason}
              </p>
            </div>
          )}

          {prioritySort && (prioritySort.harmPenaltyPercent ?? 0) > 0 && (
            <div className="mt-4 rounded-lg border border-healthy/30 bg-healthy/10 px-4 py-3">
              <p className="text-xs font-semibold text-healthy">
                {formatPercent(prioritySort.harmPenaltyPercent ?? 0, 1)} less business harm than a
                conventional priority sort
              </p>
              <p className="mt-1 text-xs leading-relaxed text-content-muted">
                A QoS-priority controller would have degraded the lowest-ranked slices to their
                ceiling before touching anything else. That plan was evaluated and priced on the
                same scale — see the alternatives below.
              </p>
            </div>
          )}
        </CardBody>
      </Card>

      {/* ---- 3 & 4. Who, and why them ---- */}
      <Card>
        <CardHeader
          title="Per-slice outcome"
          subtitle="Ordered by impact. Select a row for the factors behind it."
        />
        <Table>
          <thead>
            <tr>
              <Th>Slice</Th>
              <Th>Department</Th>
              <Th>Disposition</Th>
              <Th align="right">Business score</Th>
              <Th align="right">Before</Th>
              <Th align="right">After</Th>
              <Th align="right">Change</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {[...degraded, ...exempt, ...untouched].map((allocation) => (
              <AllocationRow
                key={allocation.sliceId}
                allocation={allocation}
                expanded={expanded === allocation.sliceId}
                onToggle={() =>
                  setExpanded(expanded === allocation.sliceId ? null : allocation.sliceId)
                }
              />
            ))}
          </tbody>
        </Table>
      </Card>

      {/* ---- 5. What else was considered ---- */}
      <Card>
        <CardHeader
          title="Alternatives considered"
          subtitle="Each priced on the same business-harm scale as the chosen plan"
        />
        <CardBody className="space-y-3">
          <div className="rounded-lg border border-brand/30 bg-brand/[0.06] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-brand">CHOSEN — Convex business-harm</span>
              <span className="tabular text-xs text-content">
                harm {decision.totalHarm.toFixed(2)}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-content-muted">
              Degradation allocated by equalising marginal business harm across slices, which
              spreads shallow cuts rather than concentrating a deep one.
            </p>
          </div>

          {decision.alternatives.map((alternative) => (
            <AlternativeRow key={alternative.strategy} alternative={alternative} />
          ))}
        </CardBody>
      </Card>

      {/* ---- 6. Under which rules ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Governing policy"
            subtitle={`${decision.policySnapshot.policyName} · revision ${decision.policySnapshot.revision}`}
          />
          <CardBody>
            <p className="mb-3 text-xs leading-relaxed text-content-muted">
              Snapshotted at decision time. Later policy edits do not change what is shown here —
              which is what keeps this decision explainable months from now.
            </p>
            <div className="space-y-1.5">
              {Object.entries(decision.policySnapshot.weights)
                .sort(([, a], [, b]) => b - a)
                .map(([factor, weight]) => (
                  <div key={factor} className="flex items-center gap-3">
                    <span className="w-44 shrink-0 truncate text-xs text-content-muted">
                      {humanise(factor.replace(/([A-Z])/g, '_$1'))}
                    </span>
                    <Bar percent={weight * 100} colourClass="bg-brand" className="h-1.5 flex-1" />
                    <span className="w-10 shrink-0 text-right tabular text-xs text-content">
                      {(weight * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Confidence breakdown" />
          <CardBody className="space-y-2.5">
            {Object.entries(decision.confidenceBreakdown)
              .filter(([key]) => key !== 'total')
              .map(([component, value]) => (
                <div key={component}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs text-content-muted">
                      {humanise(component.replace(/([A-Z])/g, '_$1'))}
                    </span>
                    <span className="tabular text-xs text-content">
                      {formatPercent(value * 100, 0)}
                    </span>
                  </div>
                  <Bar
                    percent={value * 100}
                    colourClass={value < 0.4 ? 'bg-warning' : 'bg-brand'}
                    className="h-1.5"
                  />
                </div>
              ))}

            <div className="mt-4 border-t border-edge pt-3">
              <div className="label mb-1.5">Solver diagnostics</div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                {Object.entries(decision.diagnostics).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-2">
                    <dt className="truncate text-content-subtle">
                      {DIAGNOSTIC_LABELS[key] ?? humanise(key.replace(/([A-Z])/g, '_$1'))}
                    </dt>
                    <dd className="tabular text-content">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ---- Audit trail (administrators) ---- */}
      {isAdmin && timeline && timeline.entries.length > 0 && (
        <Card>
          <CardHeader title="Audit trail" subtitle="Everything recorded about this decision" />
          <CardBody className="p-0">
            <ul className="divide-y divide-edge/60">
              {timeline.entries.map((entry) => (
                <li key={entry.id} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-content">{entry.summary}</p>
                      <p className="mt-0.5 text-[11px] text-content-subtle">
                        {entry.actor.email} · {entry.action}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-content-subtle tabular">
                      {formatDateTime(entry.occurredAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {/* ---- Override dialog ---- */}
      {overrideOpen && (
        <OverrideDialog
          reason={overrideReason}
          onReasonChange={setOverrideReason}
          onCancel={() => setOverrideOpen(false)}
          onConfirm={() => override.mutate(overrideReason)}
          pending={override.isPending}
          error={override.error instanceof ApiError ? override.error.message : null}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AllocationRow({
  allocation,
  expanded,
  onToggle,
}: {
  allocation: DecisionAllocation;
  expanded: boolean;
  onToggle: () => void;
}) {
  const style = dispositionStyle(allocation.disposition);
  const changed = allocation.reductionMbps > 0.01;

  return (
    <>
      <tr
        className={cn('cursor-pointer transition-colors hover:bg-surface-sunken', expanded && 'bg-surface-sunken')}
        onClick={onToggle}
      >
        <Td className="font-medium">{allocation.sliceName}</Td>
        <Td className="text-content-muted">{allocation.departmentName}</Td>
        <Td>
          <Badge style={style} className="text-[10px]">
            {dispositionLabel(allocation)}
          </Badge>
        </Td>
        <Td align="right">
          <Badge style={scoreStyle(allocation.businessScore)} className="text-[10px]">
            {allocation.businessScore.toFixed(1)}
          </Badge>
        </Td>
        <Td align="right" className="text-content-muted">
          {formatBandwidth(allocation.previousAllocationMbps)}
        </Td>
        <Td align="right" className={changed ? 'font-medium text-critical' : undefined}>
          {formatBandwidth(allocation.newAllocationMbps)}
        </Td>
        <Td align="right">
          {changed ? (
            <span className="text-critical">−{formatPercent(allocation.degradationPercent, 1)}</span>
          ) : (
            <span className="text-content-subtle">—</span>
          )}
        </Td>
        <Td align="right">
          <Icons.chevronRight
            className={cn('h-4 w-4 text-content-subtle transition-transform', expanded && 'rotate-90')}
          />
        </Td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={8} className="border-b border-edge bg-surface-sunken px-4 py-4">
            <p className="mb-4 max-w-3xl text-xs leading-relaxed text-content">{allocation.reason}</p>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <FactorCell
                label="Harm curvature (γ)"
                value={allocation.factors.harmCurvature.toFixed(2)}
                explanation="From the department's recovery tolerance. Higher values make harm accelerate faster with depth, so the optimiser prefers shallow cuts here."
              />
              <FactorCell
                label="Intolerance scale"
                value={`×${allocation.factors.intoleranceScale.toFixed(2)}`}
                explanation="Raises the overall harm level for a department that cannot tolerate degradation — distinct from curvature, which controls acceleration."
              />
              <FactorCell
                label="SLA stress"
                value={`×${allocation.factors.slaStress.toFixed(2)}`}
                explanation="Amplifies harm for a slice already near its SLA limit, so it is cut less."
              />
              <FactorCell
                label="Fairness"
                value={`×${allocation.factors.fairnessMultiplier.toFixed(2)}`}
                explanation="Below 1 means this slice has carried less than the fleet-average degradation burden recently, making it a cheaper choice this time. Above 1 means the opposite."
              />
              <FactorCell
                label="Recovery urgency"
                value={`×${allocation.factors.recoveryUrgency.toFixed(2)}`}
                explanation="Derived from downtime cost per minute and how long the degradation would be held."
              />
              <FactorCell
                label="Max degradation"
                value={formatPercent(allocation.factors.maxDegradationPercent, 0)}
                explanation="Hard ceiling from department policy, further clamped by compliance level. Never exceeded."
              />
              <FactorCell
                label="Available headroom"
                value={formatBandwidth(allocation.factors.headroomMbps)}
                explanation="Bandwidth that could be taken before hitting the ceiling or the contractual floor."
              />
              <FactorCell
                label="Hold duration"
                value={formatDuration(allocation.durationSeconds)}
                explanation="How long the degradation is held before automatic recovery, from the department's recovery window."
              />
            </div>

            {allocation.applicationError && (
              <div className="mt-4 rounded-lg border border-critical/30 bg-critical/10 px-3 py-2">
                <p className="text-xs font-medium text-critical">Enforcement failed</p>
                <p className="mt-0.5 text-[11px] text-content-muted">{allocation.applicationError}</p>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function FactorCell({
  label,
  value,
  explanation,
}: {
  label: string;
  value: string;
  explanation: string;
}) {
  return (
    <Tooltip content={explanation}>
      <div className="w-full rounded-lg border border-edge bg-surface-raised px-3 py-2">
        <div className="text-[10px] uppercase tracking-wide text-content-subtle">{label}</div>
        <div className="mt-0.5 tabular text-sm font-medium text-content">{value}</div>
      </div>
    </Tooltip>
  );
}

function AlternativeRow({ alternative }: { alternative: DecisionAlternative }) {
  return (
    <div className="rounded-lg border border-edge px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-content">
            {humanise(alternative.strategy)}
          </span>
          {!alternative.feasible && (
            <Badge style={statusStyles.critical} className="text-[10px]">
              Infeasible
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="tabular text-content-muted">
            harm {alternative.totalHarm.toFixed(2)}
          </span>

          {/* An infeasible alternative has NO comparable penalty: its harm is lower only
              because it degrades less while failing to resolve the contention. Showing a
              negative percentage there would rank a plan that does not work above the one
              that does. */}
          {alternative.harmPenaltyPercent === null ? (
            <Tooltip content="Not comparable: this strategy does not free enough bandwidth to resolve the contention, so its lower harm reflects doing less rather than doing better.">
              <span className="cursor-help text-content-subtle">not comparable</span>
            </Tooltip>
          ) : (
            alternative.harmPenaltyPercent !== 0 && (
              <span
                className={cn(
                  'tabular font-medium',
                  alternative.harmPenaltyPercent > 0 ? 'text-critical' : 'text-healthy',
                )}
              >
                {alternative.harmPenaltyPercent > 0 ? '+' : ''}
                {alternative.harmPenaltyPercent.toFixed(1)}%
              </span>
            )
          )}
        </div>
      </div>

      <p className="mt-1 text-[11px] leading-relaxed text-content-muted">
        {alternative.description}
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-content-subtle">
        <span className="font-medium">Rejected because:</span> {alternative.rejectedBecause}
      </p>
    </div>
  );
}

function OverrideDialog({
  reason,
  onReasonChange,
  onCancel,
  onConfirm,
  pending,
  error,
}: {
  reason: string;
  onReasonChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-lg card p-6">
        <h2 className="text-sm font-semibold text-content">Override this decision</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-content-muted">
          Every degraded slice will be restored to its baseline allocation immediately. The network
          may return to contention. Your reason is recorded permanently in the audit trail — an
          override without a recorded justification is exactly what this platform exists to prevent.
        </p>

        <label className="mt-4 block">
          <span className="label">Reason (required, minimum 10 characters)</span>
          <textarea
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            rows={3}
            className="mt-1.5 w-full rounded-lg border border-edge-strong bg-surface px-3 py-2 text-sm text-content placeholder:text-content-subtle focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            placeholder="e.g. Plant manager escalated; restoring pending manual capacity review at 14:00."
          />
        </label>

        {error && <p className="mt-2 text-xs text-critical">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            loading={pending}
            disabled={reason.trim().length < 10}
          >
            Override and restore
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Plain labels for the engine's dispositions. EXEMPT covers two cases; say which. */
function dispositionLabel(allocation: DecisionAllocation): string {
  switch (allocation.disposition) {
    case 'DEGRADED':
      return 'Cut';
    case 'PROTECTED':
      return 'Protected';
    case 'UNAFFECTED':
      return 'Not cut';
    case 'EXEMPT':
      return allocation.factors.maxDegradationPercent <= 0 ? 'Never cut' : 'Nothing to shed';
    default:
      return allocation.disposition;
  }
}

/** The solver's diagnostics, in this testbed's unit (1 engine unit = 1 kbps). */
const DIAGNOSTIC_LABELS: Record<string, string> = {
  quantumMbps: 'Step size (kbps)',
  iterations: 'Steps',
  candidatesConsidered: 'Slices considered',
  eligibleCandidates: 'Slices that could be cut',
  computeMs: 'Compute time (ms)',
  converged: 'Converged',
};
