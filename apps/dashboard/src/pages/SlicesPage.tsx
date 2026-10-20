import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { slicesApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/auth/AuthProvider';
import { useMergedSlices } from '@/hooks/useLiveData';
import { ApiError } from '@/api/client';
import {
  Badge,
  Bar,
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
  formatPercent,
  humanise,
  sliceStatusStyle,
  statusStyles,
} from '@/lib/format';

/**
 * Slice management.
 *
 * The admission-control panel sits at the top and is not decoration: creating a slice whose
 * guaranteed floor exceeds remaining headroom is rejected by the API, and an operator who
 * cannot see the headroom first will hit that rejection blind.
 */
export function SlicesPage(): JSX.Element {
  const { isManager, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { merged, isLoading } = useMergedSlices();

  const [pauseTarget, setPauseTarget] = useState<{ id: string; name: string } | null>(null);
  const [pauseReason, setPauseReason] = useState('');

  const { data: headroom } = useQuery({
    queryKey: queryKeys.slices.headroom(),
    queryFn: slicesApi.headroom,
    refetchInterval: 15_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.slices.all() });
  };

  const pause = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => slicesApi.pause(id, reason),
    onSuccess: () => {
      setPauseTarget(null);
      setPauseReason('');
      invalidate();
    },
  });

  const resume = useMutation({
    mutationFn: (id: string) => slicesApi.resume(id),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => slicesApi.remove(id),
    onSuccess: invalidate,
  });

  if (isLoading) return <LoadingState label="Loading slices" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Slice contracts"
        description="Each department has one slice: its baseline (the normal limit), its contractual floor and its SLA targets. Values are in kbps on the 1 Mbps link."
      />

      {/* ---- Admission control ---- */}
      {headroom && (
        <Card>
          <CardHeader
            title="Admission control"
            subtitle="The floors must fit inside the link, or no plan could ever be feasible"
          />
          <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Offered capacity" value={formatBandwidth(headroom.offeredCapacityMbps)} />

            <Tooltip
              content={
                <>
                  The sum of every arbitrable slice&apos;s <strong>contractual floor</strong>. If
                  this exceeded capacity, every slice could be at its floor with the network still
                  oversubscribed — a problem with no correct answer. The API rejects any slice that
                  would cross that line.
                </>
              }
            >
              <div className="w-full">
                <Metric
                  label="Committed floors"
                  value={formatBandwidth(headroom.committedFloorMbps)}
                  hint={`${formatBandwidth(headroom.availableFloorMbps)} remaining`}
                />
                <Bar
                  percent={(headroom.committedFloorMbps / headroom.offeredCapacityMbps) * 100}
                  colourClass="bg-brand"
                  className="mt-2 h-1.5"
                />
              </div>
            </Tooltip>

            <Tooltip
              content={
                <>
                  Baselines legitimately exceed capacity — that oversubscription is the normal
                  condition this platform exists to arbitrate. Only the floors must fit.
                </>
              }
            >
              <div className="w-full">
                <Metric
                  label="Committed baselines"
                  value={formatBandwidth(headroom.committedBaselineMbps)}
                  hint={`${(headroom.baselineOversubscriptionRatio * 100).toFixed(0)}% of capacity`}
                  accent={headroom.baselineOversubscriptionRatio > 1 ? 'text-warning' : undefined}
                />
              </div>
            </Tooltip>

            <Metric label="Slices" value={merged.length} hint={`${merged.filter((m) => m.slice.status === 'ACTIVE').length} active`} />
          </CardBody>
        </Card>
      )}

      {/* ---- Slice table ---- */}
      <Card>
        <CardHeader title="All slices" />
        {merged.length === 0 ? (
          <EmptyState
            icon={<Icons.slices className="h-8 w-8" />}
            title="No slices configured"
            description="Create a department first, then add slices to it."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Slice</Th>
                <Th>Department</Th>
                <Th>Status</Th>
                <Th align="right">Allocated</Th>
                <Th align="right">Baseline</Th>
                <Th align="right">Floor</Th>
                <Th align="right">Max degradation</Th>
                <Th>Profile</Th>
                {isManager && <Th align="right">Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {merged.map(({ slice, department }) => (
                <tr key={slice.id} className="transition-colors hover:bg-surface-sunken">
                  <Td>
                    <div className="font-medium">{slice.name}</div>
                    <div className="font-mono text-[10px] text-content-subtle">
                      SST {slice.snssai.sst}
                      {slice.snssai.sd && ` · SD ${slice.snssai.sd}`}
                    </div>
                  </Td>
                  <Td className="text-content-muted">{department?.name ?? '—'}</Td>
                  <Td>
                    <Badge style={sliceStatusStyle(slice.status)} dot pulse={slice.status === 'DEGRADED'}>
                      {humanise(slice.status)}
                    </Badge>
                  </Td>
                  <Td align="right" className={slice.status === 'DEGRADED' ? 'text-critical' : ''}>
                    {formatBandwidth(slice.allocatedMbps)}
                  </Td>
                  <Td align="right" className="text-content-muted">
                    {formatBandwidth(slice.baselineAllocatedMbps)}
                  </Td>
                  <Td align="right" className="text-content-muted">
                    {formatBandwidth(slice.minGuaranteedMbps)}
                  </Td>
                  <Td align="right">
                    {department?.structurallyExempt ? (
                      <Badge style={statusStyles.info} className="text-[10px]">
                        Exempt
                      </Badge>
                    ) : (
                      formatPercent(department?.effectiveDegradationCeiling ?? 0, 0)
                    )}
                  </Td>
                  <Td>
                    <span className="rounded border border-edge px-1.5 py-0.5 font-mono text-[10px] text-content-subtle">
                      {slice.profile}
                    </span>
                  </Td>

                  {isManager && (
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1">
                        {slice.status === 'PAUSED' ? (
                          <Tooltip content="Resume — re-admitted against current capacity">
                            <button
                              onClick={() => resume.mutate(slice.id)}
                              className="rounded p-1.5 text-content-muted hover:bg-surface-raised hover:text-healthy"
                              aria-label={`Resume ${slice.name}`}
                            >
                              <Icons.play className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        ) : (
                          slice.status !== 'TERMINATED' && (
                            <Tooltip content="Pause — releases capacity and leaves the arbitration pool">
                              <button
                                onClick={() => setPauseTarget({ id: slice.id, name: slice.name })}
                                className="rounded p-1.5 text-content-muted hover:bg-surface-raised hover:text-warning"
                                aria-label={`Pause ${slice.name}`}
                              >
                                <Icons.pause className="h-3.5 w-3.5" />
                              </button>
                            </Tooltip>
                          )
                        )}

                        {isAdmin && (
                          <Tooltip
                            content={
                              slice.degradationHistory.totalEvents > 0
                                ? 'Terminate — retained because it has arbitration history'
                                : 'Delete'
                            }
                          >
                            <button
                              onClick={() => {
                                if (window.confirm(`Remove slice "${slice.name}"?`)) {
                                  remove.mutate(slice.id);
                                }
                              }}
                              className="rounded p-1.5 text-content-muted hover:bg-surface-raised hover:text-critical"
                              aria-label={`Remove ${slice.name}`}
                            >
                              <Icons.close className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {(pause.error || resume.error || remove.error) && (
        <div className="rounded-lg border border-critical/30 bg-critical/10 px-4 py-3">
          <p className="text-xs text-critical">
            {[pause.error, resume.error, remove.error]
              .filter((e): e is ApiError => e instanceof ApiError)
              .map((e) => e.message)
              .join(' ')}
          </p>
        </div>
      )}

      {pauseTarget && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <div className="w-full max-w-md card p-6">
            <h2 className="text-sm font-semibold text-content">Pause {pauseTarget.name}</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-content-muted">
              The slice stops consuming capacity and leaves the arbitration pool. Any active
              degradation is cleared. Resuming later is re-admitted against capacity at that time,
              so it can legitimately fail.
            </p>

            <label className="mt-4 block">
              <span className="label">Reason (required)</span>
              <input
                value={pauseReason}
                onChange={(event) => setPauseReason(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-edge-strong bg-surface px-3 py-2 text-sm text-content focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                placeholder="e.g. Firmware upgrade on the plant controller"
              />
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPauseTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={pause.isPending}
                disabled={pauseReason.trim().length === 0}
                onClick={() => pause.mutate({ id: pauseTarget.id, reason: pauseReason })}
              >
                Pause slice
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
