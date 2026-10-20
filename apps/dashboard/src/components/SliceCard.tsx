import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import {
  Badge,
  Bar,
  Tooltip,
} from '@/components/ui';
import {
  complianceStyle,
  criticalityStyle,
  formatBandwidth,
  formatLatency,
  formatPercent,
  formatRelative,
  healthStyle,
  humanise,
  sliceStatusStyle,
  statusStyles,
} from '@/lib/format';
import { Icons } from '@/components/layout/Icons';
import type { MergedSlice } from '@/hooks/useLiveData';

/**
 * Live slice card.
 *
 * THE PRIMARY OBJECT ON THE DASHBOARD. Everything an operator needs about one slice, at a
 * glance, updating twice a second.
 *
 * Three deliberate choices:
 *
 *  1. THE BAR SHOWS DEMAND AS WELL AS ALLOCATION. A bar showing only utilisation pins at
 *     100 % under contention and stops conveying anything. The hatched overflow segment
 *     shows demand the slice is NOT receiving, which is the whole reason it is contended.
 *
 *  2. THE CONTRACTUAL FLOOR IS DRAWN AS A MARKER. It is the line arbitration may never
 *     cross, so an operator can see remaining headroom rather than compute it.
 *
 *  3. A STATE CHANGE FLASHES. Slices are watched peripherally; a value that changes silently
 *     between glances is missed. Degradation flashes red, recovery green, once, briefly.
 */
export function SliceCard({ entry, compact }: { entry: MergedSlice; compact?: boolean }): JSX.Element {
  const { slice, live, department } = entry;
  const flash = useStatusFlash(slice.status);

  const health = live?.health ?? slice.health;
  const healthColours = healthStyle(health);
  const statusColours = sliceStatusStyle(slice.status);

  const demand = live?.demandMbps ?? 0;
  const allocated = live?.allocatedMbps ?? slice.allocatedMbps;
  const used = live?.usedMbps ?? 0;
  const baseline = slice.baselineAllocatedMbps;

  /* Bar geometry is expressed against the BASELINE, so a degraded slice visibly shrinks
     rather than re-normalising to its reduced allocation and looking unchanged. */
  const scale = Math.max(baseline, demand, allocated, 1);
  const usedPercent = (used / scale) * 100;
  const overflowPercent = Math.max(0, ((demand - allocated) / scale) * 100);
  const floorPercent = (slice.minGuaranteedMbps / scale) * 100;

  const degraded = slice.status === 'DEGRADED';
  const exempt = department?.structurallyExempt ?? false;

  return (
    <div
      className={cn(
        'card card-hover relative overflow-hidden',
        degraded && 'border-critical/40',
        flash === 'degrade' && 'animate-flash-degrade',
        flash === 'recover' && 'animate-flash-recover',
      )}
    >
      {/* A degraded slice gets a coloured spine — legible from across a room, where a
          badge is not. */}
      {degraded && <div className="absolute inset-y-0 left-0 w-0.5 bg-critical" />}

      <div className={cn('p-4', compact && 'p-3')}>
        {/* ---- Header ---- */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-content">{slice.name}</h3>
              {exempt && (
                <Tooltip
                  content={
                    <>
                      <strong>Structurally exempt.</strong> {department?.name} is classified{' '}
                      {humanise(department?.complianceLevel)}, which caps degradation at 0 %. No
                      arbitration decision can reduce this slice, regardless of how severe the
                      contention becomes.
                    </>
                  }
                >
                  <span className="text-info">
                    <Icons.shield className="h-3.5 w-3.5" />
                  </span>
                </Tooltip>
              )}
            </div>

            <p className="mt-0.5 truncate text-xs text-content-muted">
              {department?.name ?? 'Unassigned'}
              {department && (
                <span className="text-content-subtle"> · {humanise(department.criticality)}</span>
              )}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge style={statusColours} dot pulse={degraded}>
              {humanise(slice.status)}
            </Badge>
            {!compact && (
              <Badge style={healthColours} className="text-[10px]">
                {health === 'UNKNOWN' ? 'No data' : humanise(health)}
              </Badge>
            )}
          </div>
        </div>

        {/* ---- Bandwidth ---- */}
        <div className="mt-3.5">
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
            <span className="tabular font-medium text-content">
              {formatBandwidth(used)}
              <span className="text-content-subtle"> / {formatBandwidth(allocated)}</span>
            </span>

            {demand > allocated + 0.5 && (
              <Tooltip
                content={
                  <>
                    This slice is asking for <strong>{formatBandwidth(demand)}</strong> but is
                    allocated {formatBandwidth(allocated)}. The shortfall is being dropped — the
                    hatched section of the bar.
                  </>
                }
              >
                <span className="tabular text-critical">
                  wants {formatBandwidth(demand)}
                </span>
              </Tooltip>
            )}
          </div>

          <Bar
            percent={usedPercent}
            overflowPercent={overflowPercent}
            markerPercent={floorPercent}
            markerLabel={`Contractual floor: ${formatBandwidth(slice.minGuaranteedMbps)}`}
            colourClass={
              degraded ? 'bg-critical' : health === 'WARNING' ? 'bg-warning' : 'bg-healthy'
            }
          />

          {degraded && slice.activeDegradation && (
            <div className="mt-1.5 flex items-center justify-between text-[11px]">
              <span className="text-critical">
                −{formatPercent(slice.activeDegradation.percent)} of baseline
              </span>
              <span className="text-content-subtle tabular">
                restores {formatRelative(slice.activeDegradation.expiresAt)}
              </span>
            </div>
          )}
        </div>

        {/* ---- Metrics ---- */}
        {!compact && (
          <div className="mt-3.5 grid grid-cols-4 gap-2 border-t border-edge pt-3">
            <MiniMetric
              label="Latency"
              value={formatLatency(live?.latencyMs)}
              breached={live?.breaches.includes('latency')}
              target={`≤ ${formatLatency(slice.slaTargets.maxLatencyMs)}`}
            />
            <MiniMetric
              label="Loss"
              value={live ? formatPercent(live.packetLossPercent, 2) : '—'}
              breached={live?.breaches.includes('packetLoss')}
              target={`≤ ${formatPercent(slice.slaTargets.maxPacketLossPercent, 2)}`}
            />
            <MiniMetric
              label="CPU"
              value={live ? formatPercent(live.cpuPercent, 0) : '—'}
              breached={(live?.cpuPercent ?? 0) > 90}
            />
            <MiniMetric
              label="Memory"
              value={live ? formatPercent(live.memoryPercent, 0) : '—'}
              breached={(live?.memoryPercent ?? 0) > 90}
            />
          </div>
        )}

        {/* ---- SLA stress ---- */}
        {!compact && live && (
          <div className="mt-3">
            <Tooltip
              content={
                <>
                  <strong>SLA stress</strong> is how much of the slice&apos;s SLA budget is
                  consumed, taken as the worst dimension rather than an average. The arbitration
                  engine reads this exact value: a stressed slice is more damaging to degrade
                  further, so its harm is amplified and it is cut less.
                </>
              }
            >
              <div className="w-full">
                <div className="mb-1 flex items-center justify-between">
                  <span className="label">SLA stress</span>
                  <span
                    className={cn(
                      'tabular text-xs font-medium',
                      live.slaStress > 0.85
                        ? 'text-critical'
                        : live.slaStress > 0.6
                          ? 'text-warning'
                          : 'text-content-muted',
                    )}
                  >
                    {formatPercent(live.slaStress * 100, 0)}
                  </span>
                </div>
                <Bar
                  percent={live.slaStress * 100}
                  colourClass={
                    live.slaStress > 0.85
                      ? 'bg-critical'
                      : live.slaStress > 0.6
                        ? 'bg-warning'
                        : 'bg-healthy'
                  }
                  className="h-1"
                />
              </div>
            </Tooltip>
          </div>
        )}

        {/* ---- Footer ---- */}
        {!compact && (
          <div className="mt-3 flex items-center justify-between border-t border-edge pt-2.5">
            <div className="flex items-center gap-1.5">
              {department && (
                <Badge style={criticalityStyle(department.criticality)} className="text-[10px]">
                  {humanise(department.criticality)}
                </Badge>
              )}
              {department && department.complianceLevel !== 'NONE' && (
                <Badge style={complianceStyle(department.complianceLevel)} className="text-[10px]">
                  {humanise(department.complianceLevel)}
                </Badge>
              )}
              {/* Network profile is shown but visually de-emphasised: it is recorded for
                  3GPP interoperability and is NOT what decides arbitration. */}
              <Tooltip
                content={
                  <>
                    3GPP slice profile, carried for core-network interoperability.{' '}
                    <strong>It is not an input to arbitration</strong> — degradation is decided
                    entirely from department business policy.
                  </>
                }
              >
                <span className="rounded border border-edge px-1.5 py-0.5 font-mono text-[10px] text-content-subtle">
                  {slice.profile}
                </span>
              </Tooltip>
            </div>

            {slice.activeDegradation && (
              <Link
                to={`/arbitration/${slice.activeDegradation.decisionId}`}
                className="flex items-center gap-0.5 text-[11px] font-medium text-brand hover:underline"
              >
                Why?
                <Icons.chevronRight className="h-3 w-3" />
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MiniMetric({
  label,
  value,
  target,
  breached,
}: {
  label: string;
  value: string;
  target?: string;
  breached?: boolean;
}) {
  const content = (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-content-subtle">{label}</div>
      <div
        className={cn(
          'mt-0.5 truncate tabular text-xs font-medium',
          breached ? 'text-critical' : 'text-content',
        )}
      >
        {value}
      </div>
    </div>
  );

  return target ? (
    <Tooltip content={`SLA target: ${target}`}>{content}</Tooltip>
  ) : (
    content
  );
}

/**
 * Flash on a state transition.
 *
 * Slices are watched peripherally across a wall of cards. A degradation that appears
 * silently between glances is missed entirely, so the transition itself is animated once —
 * not the steady state, which would be a permanently flashing display nobody can read.
 */
function useStatusFlash(status: string): 'degrade' | 'recover' | null {
  const previous = useRef(status);
  const [flash, setFlash] = useState<'degrade' | 'recover' | null>(null);

  useEffect(() => {
    if (previous.current === status) return;

    const wasDegraded = previous.current === 'DEGRADED';
    const isDegraded = status === 'DEGRADED';
    previous.current = status;

    if (isDegraded) setFlash('degrade');
    else if (wasDegraded) setFlash('recover');
    else return;

    const timer = setTimeout(() => setFlash(null), 1300);
    return () => clearTimeout(timer);
  }, [status]);

  return flash;
}

export { statusStyles };
