import { useQuery } from '@tanstack/react-query';
import { departmentsApi, policiesApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import {
  Badge,
  Bar,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LoadingState,
  PageHeader,
  Table,
  Td,
  Th,
  Tooltip,
} from '@/components/ui';
import { Icons } from '@/components/layout/Icons';
import {
  complianceStyle,
  criticalityStyle,
  formatBandwidth,
  formatCurrency,
  formatPercent,
  humanise,
  recoveryToleranceStyle,
  statusStyles,
} from '@/lib/format';

/**
 * Departments.
 *
 * These attributes — and nothing else — decide which slices get degraded. The page is laid
 * out to make that legible: the arbitration-relevant fields are the table's columns, and
 * each has a tooltip explaining how the engine actually uses it.
 */
export function DepartmentsPage(): JSX.Element {
  const { data: summaries, isLoading } = useQuery({
    queryKey: queryKeys.departments.summary(),
    queryFn: departmentsApi.summary,
    refetchInterval: 20_000,
  });

  const { data: policy } = useQuery({
    queryKey: queryKeys.policies.effective(),
    queryFn: policiesApi.effective,
    staleTime: 60_000,
  });

  if (isLoading) return <LoadingState label="Loading departments" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Departments"
        description="The business facts behind every decision: criticality, cost of an outage, compliance, customer impact and recovery tolerance."
      />

      <Card>
        <CardHeader
          title="Arbitration attributes"
          subtitle="Hover a column heading to see how the engine uses it"
        />
        {!summaries || summaries.length === 0 ? (
          <EmptyState
            icon={<Icons.departments className="h-8 w-8" />}
            title="No departments"
            description="Create a department to give slices business context."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Department</Th>
                <Th>
                  <Tooltip content="Ordinal criticality, translated to a 0–100 score by the active policy. The single heaviest weighted factor by default.">
                    <span className="cursor-help border-b border-dotted border-content-subtle">
                      Criticality
                    </span>
                  </Tooltip>
                </Th>
                <Th>
                  <Tooltip content="Imposes a HARD degradation ceiling that no amount of harm avoided elsewhere can override. LIFE_SAFETY = 0 %, REGULATED = 20 %, CONTRACTUAL = 60 %.">
                    <span className="cursor-help border-b border-dotted border-content-subtle">
                      Compliance
                    </span>
                  </Tooltip>
                </Th>
                <Th align="right">
                  <Tooltip content="Normalised LOGARITHMICALLY before scoring, so one department declaring an extreme figure cannot saturate the weight vector and flatten every other factor.">
                    <span className="cursor-help border-b border-dotted border-content-subtle">
                      Downtime cost
                    </span>
                  </Tooltip>
                </Th>
                <Th>
                  <Tooltip content="Sets both the harm curvature (how fast harm accelerates with depth) and the recovery window (how long a degradation is held before automatic restoration).">
                    <span className="cursor-help border-b border-dotted border-content-subtle">
                      Recovery tolerance
                    </span>
                  </Tooltip>
                </Th>
                <Th align="right">
                  <Tooltip content="The tighter of the department's own limit and its compliance ceiling. This is the number arbitration actually obeys.">
                    <span className="cursor-help border-b border-dotted border-content-subtle">
                      Max degradation
                    </span>
                  </Tooltip>
                </Th>
                <Th align="right">Slices</Th>
                <Th align="right">Allocated</Th>
              </tr>
            </thead>
            <tbody>
              {summaries.map(({ department, sliceCount, allocatedMbps, degradedSliceCount }) => (
                <tr key={department.id} className="transition-colors hover:bg-surface-sunken">
                  <Td>
                    <div className="font-medium">{department.name}</div>
                    {department.ownerEmail && (
                      <div className="text-[10px] text-content-subtle">{department.ownerEmail}</div>
                    )}
                  </Td>
                  <Td>
                    <Badge style={criticalityStyle(department.criticality)} className="text-[10px]">
                      {humanise(department.criticality)}
                    </Badge>
                  </Td>
                  <Td>
                    <Badge style={complianceStyle(department.complianceLevel)} className="text-[10px]">
                      {humanise(department.complianceLevel)}
                    </Badge>
                  </Td>
                  <Td align="right">{formatCurrency(department.downtimeCostPerMinute)}/min</Td>
                  <Td>
                    <Badge
                      style={recoveryToleranceStyle(department.recoveryTolerance)}
                      className="text-[10px]"
                    >
                      {humanise(department.recoveryTolerance)}
                      {policy && (
                        <span className="ml-1 opacity-70">
                          γ{policy.harmCurvature[department.recoveryTolerance]?.toFixed(1)}
                        </span>
                      )}
                    </Badge>
                  </Td>
                  <Td align="right">
                    {department.structurallyExempt ? (
                      <Badge style={statusStyles.info} className="text-[10px]">
                        Exempt
                      </Badge>
                    ) : (
                      <span
                        className={
                          department.effectiveDegradationCeiling <
                          department.maxAllowedDegradationPercent
                            ? 'text-warning'
                            : ''
                        }
                      >
                        {formatPercent(department.effectiveDegradationCeiling, 0)}
                        {department.effectiveDegradationCeiling <
                          department.maxAllowedDegradationPercent && (
                          <Tooltip
                            content={`Configured at ${department.maxAllowedDegradationPercent}% but clamped by the ${humanise(department.complianceLevel)} compliance ceiling.`}
                          >
                            <span className="ml-1 cursor-help text-[10px]">▾</span>
                          </Tooltip>
                        )}
                      </span>
                    )}
                  </Td>
                  <Td align="right">
                    {sliceCount}
                    {degradedSliceCount > 0 && (
                      <span className="ml-1 text-critical">({degradedSliceCount}↓)</span>
                    )}
                  </Td>
                  <Td align="right">{formatBandwidth(allocatedMbps)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Score composition ---- */}
      {summaries && summaries.length > 0 && (
        <Card>
          <CardHeader
            title="Relative business importance"
            subtitle="Declared importance and operational weight, side by side"
          />
          <CardBody className="space-y-3">
            {[...summaries]
              .sort((a, b) => b.department.businessImportance - a.department.businessImportance)
              .map(({ department }) => (
                <div key={department.id} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 truncate text-xs text-content-muted">
                    {department.name}
                  </span>
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-[10px] text-content-subtle">business</span>
                      <Bar
                        percent={department.businessImportance}
                        colourClass="bg-brand"
                        className="h-1.5 flex-1"
                      />
                      <span className="w-8 shrink-0 text-right tabular text-[10px] text-content">
                        {department.businessImportance}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-[10px] text-content-subtle">
                        operational
                      </span>
                      <Bar
                        percent={department.operationalImportance}
                        colourClass="bg-info"
                        className="h-1.5 flex-1"
                      />
                      <span className="w-8 shrink-0 text-right tabular text-[10px] text-content">
                        {department.operationalImportance}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
