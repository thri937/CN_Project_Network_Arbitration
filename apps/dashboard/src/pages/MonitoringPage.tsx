import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { testbedApi, type GatewaySliceStats } from '@/api/resources';
import { useSlicesWithDepartments } from '@/hooks/useLiveData';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui';
import { formatBandwidth, formatLatency, formatPercent, formatTime } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * Live charts: the gateway's measurements for one slice, over the last few minutes.
 *
 * The history is kept in this page (one point per 2 s gateway window, about 6 minutes), so it
 * starts empty when the page opens. Gaps in latency mean no probe was answered in that window.
 */

const MAX_POINTS = 180;
const ORDER = [
  'patient-telemetry',
  'factory-automation',
  'lab-instrumentation',
  'warehouse-operations',
  'cctv',
  'office-wi-fi',
  'canteen-signage',
];

interface Point {
  t: number;
  demand: number;
  limit: number;
  carried: number;
  latency: number | null;
  loss: number;
}

const AXIS = { stroke: 'rgb(var(--content-subtle))', fontSize: 11, tickLine: false, axisLine: false };
const GRID = { stroke: 'rgb(var(--edge))', strokeDasharray: '3 3' };
const TOOLTIP = {
  contentStyle: {
    backgroundColor: 'rgb(var(--surface-raised))',
    border: '1px solid rgb(var(--edge-strong))',
    borderRadius: 6,
    fontSize: 12,
  },
};

export function MonitoringPage(): JSX.Element {
  const status = useQuery({ queryKey: ['testbed', 'status'], queryFn: testbedApi.status, refetchInterval: 2000 });
  const { slices, departmentById } = useSlicesWithDepartments();
  const rows = useMemo(() => [...slices].sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code)), [slices]);
  const [code, setCode] = useState('canteen-signage');

  // History per slice, appended once per new gateway window.
  const history = useRef(new Map<string, Point[]>());
  const lastAt = useRef(0);
  const [, setVersion] = useState(0);
  useEffect(() => {
    const stats = status.data?.stats ?? [];
    const at = Math.max(0, ...stats.map((s) => s.atMs));
    if (!stats.length || at <= lastAt.current) return;
    lastAt.current = at;
    for (const s of stats) {
      const list = history.current.get(s.code) ?? [];
      list.push(toPoint(s));
      if (list.length > MAX_POINTS) list.splice(0, list.length - MAX_POINTS);
      history.current.set(s.code, list);
    }
    setVersion((v) => v + 1);
  }, [status.data]);

  const slice = rows.find((r) => r.code === code);
  const series = history.current.get(code) ?? [];
  const latest = series[series.length - 1];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Live charts"
        description="What the gateway measured for one slice, every 2 seconds, since this page was opened."
      />

      <div className="flex flex-wrap gap-2">
        {rows.map((r) => (
          <button
            key={r.code}
            onClick={() => setCode(r.code)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-sm',
              r.code === code ? 'border-brand bg-brand/10 text-content' : 'border-edge text-content-muted hover:text-content',
            )}
          >
            {departmentById.get(r.departmentId)?.name ?? r.name}
          </button>
        ))}
      </div>

      {slice && (
        <div className="grid gap-4 sm:grid-cols-4">
          <Figure label="Demand" value={formatBandwidth(latest?.demand ?? null)} />
          <Figure label="Limit" value={formatBandwidth(latest?.limit ?? slice.allocatedMbps)} note={`baseline ${formatBandwidth(slice.baselineAllocatedMbps)}`} />
          <Figure label="Carried" value={formatBandwidth(latest?.carried ?? null)} />
          <Figure
            label="Latency p95 / loss"
            value={`${formatLatency(latest?.latency ?? null)} / ${latest ? formatPercent(latest.loss, 1) : '—'}`}
            note={`targets ${formatLatency(slice.slaTargets.maxLatencyMs)} / ${formatPercent(slice.slaTargets.maxPacketLossPercent, 1)}`}
          />
        </div>
      )}

      <Card>
        <CardHeader title="Throughput" subtitle="Demand is what the devices ask for; the limit is what the slice may send; carried is what got through." />
        <CardBody>
          <Chart data={series}>
            <YAxis {...AXIS} width={70} tickFormatter={(v: number) => formatBandwidth(v)} />
            <Tooltip {...TOOLTIP} labelFormatter={(t) => formatTime(Number(t))} formatter={(v: number) => formatBandwidth(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="stepAfter" dataKey="demand" name="Demand" stroke="rgb(var(--warning))" dot={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="limit" name="Limit" stroke="rgb(var(--content-muted))" strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="carried" name="Carried" stroke="rgb(var(--brand))" strokeWidth={2} dot={false} isAnimationActive={false} />
          </Chart>
        </CardBody>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Latency (p95 of probe round trips)" subtitle={slice ? `Target ${formatLatency(slice.slaTargets.maxLatencyMs)}` : undefined} />
          <CardBody>
            <Chart data={series}>
              <YAxis {...AXIS} width={60} tickFormatter={(v: number) => `${v} ms`} />
              <Tooltip {...TOOLTIP} labelFormatter={(t) => formatTime(Number(t))} formatter={(v: number) => formatLatency(v)} />
              {slice && <ReferenceLine y={slice.slaTargets.maxLatencyMs} stroke="rgb(var(--critical))" strokeDasharray="4 3" />}
              <Line type="monotone" dataKey="latency" name="Latency p95" stroke="rgb(var(--brand))" dot={false} connectNulls={false} isAnimationActive={false} />
            </Chart>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Loss" subtitle={slice ? `Target ${formatPercent(slice.slaTargets.maxPacketLossPercent, 1)}` : undefined} />
          <CardBody>
            <Chart data={series}>
              <YAxis {...AXIS} width={50} tickFormatter={(v: number) => `${v} %`} />
              <Tooltip {...TOOLTIP} labelFormatter={(t) => formatTime(Number(t))} formatter={(v: number) => formatPercent(v, 1)} />
              {slice && <ReferenceLine y={slice.slaTargets.maxPacketLossPercent} stroke="rgb(var(--critical))" strokeDasharray="4 3" />}
              <Line type="monotone" dataKey="loss" name="Loss" stroke="rgb(var(--degraded))" dot={false} isAnimationActive={false} />
            </Chart>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function toPoint(s: GatewaySliceStats): Point {
  return {
    t: s.atMs,
    demand: s.demandKbps,
    limit: s.limitKbps,
    carried: s.usedKbps,
    latency: s.latencyP95Ms,
    loss: s.lossPct,
  };
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-raised p-4">
      <div className="text-xs text-content-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold text-content">{value}</div>
      {note && <div className="mt-0.5 text-xs text-content-subtle">{note}</div>}
    </div>
  );
}

function Chart({ data, children }: { data: Point[]; children: React.ReactNode }) {
  if (data.length < 2) {
    return <div className="grid h-56 place-items-center text-sm text-content-muted">Collecting measurements…</div>;
  }
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="t" {...AXIS} tickFormatter={(t: number) => formatTime(t)} minTickGap={40} />
          {children}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
