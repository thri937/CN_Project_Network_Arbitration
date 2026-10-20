import { useQuery } from '@tanstack/react-query';
import { policiesApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import {
  Badge,
  Bar,
  Card,
  CardBody,
  CardHeader,
  LoadingState,
  PageHeader,
  Table,
  Td,
  Th,
  Tooltip,
} from '@/components/ui';
import { formatDateTime, humanise, statusStyles } from '@/lib/format';

/**
 * Business policies.
 *
 * Shows the RESOLVED configuration — every override merged over the defaults, compliance
 * ceilings already clamped — because that is the exact object the arbitration engine
 * consumes. Displaying the raw policy document instead would let the screen and the engine
 * disagree, which is the one thing a governance page must never do.
 */
export function PoliciesPage(): JSX.Element {
  const { data: effective, isLoading } = useQuery({
    queryKey: queryKeys.policies.effective(),
    queryFn: policiesApi.effective,
  });

  const { data: history } = useQuery({
    queryKey: queryKeys.policies.list(),
    queryFn: () => policiesApi.list({ limit: 50 }),
  });

  if (isLoading || !effective) return <LoadingState label="Loading policy" />;

  const weights = Object.entries(effective.weights).sort(([, a], [, b]) => b - a);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Business Policies"
        description="How department attributes are weighed against one another. Changing this changes every future arbitration outcome."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ---- Weights ---- */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Priority weighting"
            subtitle={`${effective.policyName} · revision ${effective.revision}`}
            action={
              <Badge style={statusStyles.healthy} dot>
                Governing
              </Badge>
            }
          />
          <CardBody className="space-y-3">
            {weights.map(([factor, weight]) => (
              <div key={factor} className="flex items-center gap-3">
                <span className="w-44 shrink-0 truncate text-xs text-content-muted">
                  {humanise(factor.replace(/([A-Z])/g, '_$1'))}
                </span>
                <Bar percent={weight * 100} colourClass="bg-brand" className="h-2 flex-1" />
                <span className="w-12 shrink-0 text-right tabular text-xs font-medium text-content">
                  {(weight * 100).toFixed(0)}%
                </span>
              </div>
            ))}

            <p className="mt-4 border-t border-edge pt-3 text-[11px] leading-relaxed text-content-muted">
              Weights sum to exactly 100 %. Compliance appears here as a weighted factor{' '}
              <em>and</em> separately as a hard ceiling — the ceiling is a constraint the optimiser
              cannot trade away, which is why a life-safety slice is never degraded regardless of
              how the weights are set.
            </p>
          </CardBody>
        </Card>

        {/* ---- Solver tuning ---- */}
        <Card>
          <CardHeader title="Arbitration tuning" />
          <CardBody className="space-y-3 text-xs">
            <Setting
              label="Fairness λ"
              value={effective.arbitration.fairnessLambda.toFixed(2)}
              explanation="Strength of the historical-fairness correction. A slice that has absorbed more than the fleet-average degradation recently becomes proportionally more expensive to degrade again, which rotates the burden over time. Zero disables rotation."
            />
            <Setting
              label="SLA stress gain"
              value={effective.arbitration.slaStressGain.toFixed(2)}
              explanation="How much a slice already near its SLA limit is protected. Harm is multiplied by 1 + gain × stress."
            />
            <Setting
              label="Target headroom"
              value={`${(effective.arbitration.targetHeadroomFraction * 100).toFixed(1)}%`}
              explanation="Arbitration frees enough bandwidth to reach this much headroom below capacity, rather than exactly to the line — driving to 100 % oscillates."
            />
            <Setting
              label="Degradation quantum"
              value={`${(effective.arbitration.degradationQuantum * 100).toFixed(2)}%`}
              explanation="Step size of the water-filling allocator, as a fraction of total demand. Smaller is closer to the continuous optimum but takes more iterations."
            />
            <Setting
              label="Cost reference"
              value={effective.arbitration.downtimeCostReference.toLocaleString()}
              explanation="Downtime cost per minute that normalises to a score of 50. Scaling is logarithmic around this point."
            />
          </CardBody>
        </Card>
      </div>

      {/* ---- Ordinal translation ---- */}
      <Card>
        <CardHeader
          title="Ordinal to cardinal translation"
          subtitle="Business stakeholders reason in categories; the mathematics needs numbers. This is the auditable translation point."
        />
        <CardBody className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          <ScoreTable title="Criticality" scores={effective.criticalityScore} />
          <ScoreTable title="Compliance" scores={effective.complianceScore} />
          <ScoreTable title="Customer impact" scores={effective.customerImpactScore} />
          <ScoreTable
            title="Compliance ceiling"
            scores={effective.complianceCeilingPercent}
            suffix="%"
            note="Hard constraint — a policy may tighten these but never loosen them."
          />
        </CardBody>
      </Card>

      {/* ---- Harm curvature ---- */}
      <Card>
        <CardHeader
          title="Recovery tolerance → harm shape"
          subtitle="The parameter that makes this algorithm spread cuts rather than sort and gut"
        />
        <CardBody>
          <Table>
            <thead>
              <tr>
                <Th>Tolerance</Th>
                <Th align="right">Harm curvature (γ)</Th>
                <Th align="right">Intolerance score</Th>
                <Th align="right">Recovery window</Th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(effective.harmCurvature).map((tolerance) => (
                <tr key={tolerance}>
                  <Td className="font-medium">{humanise(tolerance)}</Td>
                  <Td align="right">{effective.harmCurvature[tolerance]?.toFixed(2)}</Td>
                  <Td align="right">{effective.recoveryIntoleranceScore[tolerance]?.toFixed(0)}</Td>
                  <Td align="right">{effective.recoveryWindowSeconds[tolerance]}s</Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <p className="mt-4 text-[11px] leading-relaxed text-content-muted">
            Harm rises as <span className="font-mono">depth^γ</span>. A γ of 3.0 means the last few
            percent of a cut cost dramatically more than the first — so after a shallow cut the
            optimiser moves on to another slice rather than continuing to take from this one. That
            is what produces many shallow degradations instead of one deep one, and it is the
            structural difference from a priority sort. The intolerance score separately raises the
            overall harm <em>level</em>, so an intolerant department is both cut less and cut later.
          </p>
        </CardBody>
      </Card>

      {/* ---- Revision history ---- */}
      {history && history.items.length > 0 && (
        <Card>
          <CardHeader
            title="Revision history"
            subtitle="An active policy is never edited in place — editing forks a new draft revision"
          />
          <Table>
            <thead>
              <tr>
                <Th>Revision</Th>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Effective from</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((policy) => (
                <tr key={policy.id}>
                  <Td className="tabular font-medium">#{policy.revision}</Td>
                  <Td>{policy.name}</Td>
                  <Td>
                    <Badge
                      style={
                        policy.status === 'ACTIVE'
                          ? statusStyles.healthy
                          : policy.status === 'DRAFT'
                            ? statusStyles.info
                            : statusStyles.neutral
                      }
                      className="text-[10px]"
                    >
                      {policy.status}
                    </Badge>
                  </Td>
                  <Td className="text-content-muted">
                    {policy.effectiveFrom ? formatDateTime(policy.effectiveFrom) : '—'}
                  </Td>
                  <Td className="text-content-muted">{formatDateTime(policy.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function Setting({
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
      <div className="flex w-full items-center justify-between gap-2 border-b border-edge/60 pb-2">
        <span className="cursor-help border-b border-dotted border-content-subtle text-content-muted">
          {label}
        </span>
        <span className="tabular font-medium text-content">{value}</span>
      </div>
    </Tooltip>
  );
}

function ScoreTable({
  title,
  scores,
  suffix = '',
  note,
}: {
  title: string;
  scores: Record<string, number>;
  suffix?: string;
  note?: string;
}) {
  return (
    <div>
      <div className="label mb-2">{title}</div>
      <div className="space-y-1">
        {Object.entries(scores).map(([key, value]) => (
          <div key={key} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate text-content-muted">{humanise(key)}</span>
            <span className="tabular font-medium text-content">
              {value}
              {suffix}
            </span>
          </div>
        ))}
      </div>
      {note && <p className="mt-2 text-[10px] leading-relaxed text-content-subtle">{note}</p>}
    </div>
  );
}
