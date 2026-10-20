import { useQuery } from '@tanstack/react-query';
import { reportsApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import {
  Badge,
  Bar,
  Card,
  CardBody,
  CardHeader,
  LoadingState,
  Metric,
  PageHeader,
  Table,
  Td,
  Th,
  Tooltip,
} from '@/components/ui';
import {
  capacityLevelStyle,
  complianceStyle,
  criticalityStyle,
  formatBandwidth,
  formatPercent,
  humanise,
  statusStyles,
} from '@/lib/format';

/**
 * Reports.
 *
 * Leads with harm avoided versus a conventional priority sort, because that figure is the
 * entire business case for this platform over the approach it replaces. Burying it below
 * throughput charts would make the page a status display rather than an argument.
 */
export function ReportsPage(): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.reports.overview(),
    queryFn: () => reportsApi.overview(),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) return <LoadingState label="Building report" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Operational summary for the last seven days."
      />

      {/* ---- The headline ---- */}
      <Card className="border-healthy/30">
        <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Tooltip
            content={
              <>
                On every decision, the engine also prices what a conventional{' '}
                <strong>priority-sort</strong> controller would have done — degrading the
                lowest-ranked slices to their ceiling first — on the identical business-harm
                scale. This is the average difference.
              </>
            }
          >
            <div className="w-full">
              <Metric
                label="Business harm avoided"
                value={formatPercent(data.headline.harmAvoidedVsPrioritySortPercent, 1)}
                hint="versus a conventional priority sort"
                accent="text-healthy"
                size="lg"
              />
            </div>
          </Tooltip>

          <Metric label="Arbitration runs" value={data.headline.arbitrationRuns} />
          <Metric
            label="Bandwidth freed"
            value={formatBandwidth(data.headline.bandwidthFreedMbps)}
          />
          <Metric
            label="Mean confidence"
            value={formatPercent(data.headline.meanConfidence * 100, 0)}
          />
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---- Outcomes ---- */}
        <Card>
          <CardHeader title="Decision outcomes" />
          <CardBody className="space-y-3">
            {Object.entries(data.outcomes).length === 0 ? (
              <p className="text-xs text-content-muted">No decisions in this window.</p>
            ) : (
              Object.entries(data.outcomes).map(([outcome, count]) => {
                const total = Object.values(data.outcomes).reduce((a, b) => a + b, 0);
                return (
                  <div key={outcome} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 text-xs text-content-muted">{outcome}</span>
                    <Bar
                      percent={(count / total) * 100}
                      colourClass={
                        outcome === 'RESOLVED'
                          ? 'bg-healthy'
                          : outcome === 'ESCALATED'
                            ? 'bg-critical'
                            : 'bg-warning'
                      }
                      className="h-2 flex-1"
                    />
                    <span className="w-8 shrink-0 text-right tabular text-xs text-content">
                      {count}
                    </span>
                  </div>
                );
              })
            )}
          </CardBody>
        </Card>

        {/* ---- Capacity ---- */}
        <Card>
          <CardHeader title="Capacity position" />
          <CardBody className="space-y-4">
            {data.capacity ? (
              <>
                <div className="flex items-center gap-2">
                  <Badge style={capacityLevelStyle(data.capacity.level)} dot>
                    {humanise(data.capacity.level)}
                  </Badge>
                  {data.capacity.oversubscribed && (
                    <span className="text-xs text-critical">
                      demand at {formatPercent(data.capacity.demandRatio * 100, 0)} of capacity
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <Metric
                    label="Committed floors"
                    value={formatBandwidth(data.admission.committedFloorMbps)}
                    hint={`${formatBandwidth(data.admission.availableFloorMbps)} of admission headroom left`}
                  />
                  <Metric
                    label="Baseline oversubscription"
                    value={`${(data.admission.baselineOversubscriptionRatio * 100).toFixed(0)}%`}
                    hint="of offered capacity — expected and managed"
                    accent={
                      data.admission.baselineOversubscriptionRatio > 1 ? 'text-warning' : undefined
                    }
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-content-muted">No capacity measurement available.</p>
            )}
          </CardBody>
        </Card>
      </div>

      {/* ---- Degradation burden ---- */}
      <Card>
        <CardHeader
          title="Degradation burden by department"
          subtitle="The fairness term rotates this over time — a persistently uneven distribution is worth investigating"
        />
        {data.degradationsByDepartment.length === 0 ? (
          <CardBody>
            <p className="text-xs text-content-muted">No degradations in this window.</p>
          </CardBody>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Department</Th>
                <Th align="right">Times degraded</Th>
                <Th align="right">Total reduced</Th>
              </tr>
            </thead>
            <tbody>
              {data.degradationsByDepartment.map((row) => (
                <tr key={row.departmentId}>
                  <Td className="font-medium">{row.departmentName}</Td>
                  <Td align="right">{row.degradationCount}</Td>
                  <Td align="right">{formatBandwidth(row.totalReducedMbps)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Department position ---- */}
      <Card>
        <CardHeader title="Capacity by department" />
        <Table>
          <thead>
            <tr>
              <Th>Department</Th>
              <Th>Criticality</Th>
              <Th>Compliance</Th>
              <Th align="right">Slices</Th>
              <Th align="right">Allocated</Th>
              <Th align="right">Share of capacity</Th>
              <Th align="right">Max degradation</Th>
            </tr>
          </thead>
          <tbody>
            {data.departments.map((department) => (
              <tr key={department.departmentId}>
                <Td className="font-medium">{department.name}</Td>
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
                <Td align="right">
                  {department.sliceCount}
                  {department.degradedSliceCount > 0 && (
                    <span className="ml-1 text-critical">({department.degradedSliceCount}↓)</span>
                  )}
                </Td>
                <Td align="right">{formatBandwidth(department.allocatedMbps)}</Td>
                <Td align="right">
                  <div className="flex items-center justify-end gap-2">
                    <Bar
                      percent={department.shareOfCapacityPercent}
                      colourClass="bg-brand"
                      className="h-1.5 w-16"
                    />
                    <span className="w-10 text-right">
                      {formatPercent(department.shareOfCapacityPercent, 0)}
                    </span>
                  </div>
                </Td>
                <Td align="right">
                  {department.effectiveDegradationCeiling === 0 ? (
                    <Badge style={statusStyles.info} className="text-[10px]">
                      Exempt
                    </Badge>
                  ) : (
                    formatPercent(department.effectiveDegradationCeiling, 0)
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
