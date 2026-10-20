import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatBandwidth, formatTime } from '@/lib/format';
import type { TimePoint } from '@/hooks/useLiveData';

/**
 * Live charts.
 *
 * Shared configuration in one place so every chart on the dashboard reads the same way.
 *
 * Choices that matter for a control room:
 *
 *  • ANIMATION IS OFF. Recharts animates data changes by default; at a 2 Hz update rate the
 *    chart never settles and is unreadable. The data arrives smoothly enough that the line
 *    already moves naturally.
 *  • The x-axis is clock time, not an index. An operator correlating with an incident
 *    timeline needs real times.
 *  • Colours come from the CSS variables, so charts follow the theme rather than carrying
 *    their own palette that looks wrong in one of the two.
 */

const AXIS = {
  stroke: 'rgb(var(--content-subtle))',
  fontSize: 10,
  tickLine: false,
  axisLine: false,
};

const GRID = { stroke: 'rgb(var(--edge))', strokeDasharray: '3 3' };

function tooltipStyle() {
  return {
    contentStyle: {
      backgroundColor: 'rgb(var(--surface-raised))',
      border: '1px solid rgb(var(--edge-strong))',
      borderRadius: '0.5rem',
      fontSize: '11px',
      padding: '8px 10px',
    },
    labelStyle: { color: 'rgb(var(--content-muted))', marginBottom: 4 },
    itemStyle: { padding: '1px 0' },
  };
}

/* ------------------------------------------------------------------ */

/**
 * Capacity over time.
 *
 * The capacity line is drawn as a hard reference rather than as another series, because it
 * is a constraint, not a measurement — and the demand line crossing it IS the contention
 * event. Rendering both as ordinary lines would bury that moment.
 */
export function CapacityChart({
  data,
  capacityMbps,
  height = 200,
}: {
  data: TimePoint[];
  capacityMbps: number;
  height?: number;
}): JSX.Element {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id="demandFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--critical))" stopOpacity={0.28} />
            <stop offset="100%" stopColor="rgb(var(--critical))" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="usedFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--brand))" stopOpacity={0.32} />
            <stop offset="100%" stopColor="rgb(var(--brand))" stopOpacity={0.02} />
          </linearGradient>
        </defs>

        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="t" tickFormatter={formatTime} {...AXIS} minTickGap={48} />
        <YAxis tickFormatter={(v: number) => formatBandwidth(v, 0)} {...AXIS} width={62} />

        <RechartsTooltip
          {...tooltipStyle()}
          labelFormatter={(value) => formatTime(Number(value))}
          formatter={(value: number, name: string) => [formatBandwidth(value), LABELS[name] ?? name]}
        />

        {/* The constraint, not a series. */}
        <ReferenceLine
          y={capacityMbps}
          stroke="rgb(var(--warning))"
          strokeDasharray="5 4"
          strokeWidth={1.5}
          label={{
            value: 'Offered capacity',
            position: 'insideTopRight',
            fill: 'rgb(var(--warning))',
            fontSize: 10,
          }}
        />

        <Area
          type="monotone"
          dataKey="demand"
          stroke="rgb(var(--critical))"
          strokeWidth={1.75}
          fill="url(#demandFill)"
          isAnimationActive={false}
          dot={false}
        />
        <Area
          type="monotone"
          dataKey="used"
          stroke="rgb(var(--brand))"
          strokeWidth={1.75}
          fill="url(#usedFill)"
          isAnimationActive={false}
          dot={false}
        />

        <Legend
          verticalAlign="top"
          height={24}
          iconType="plainline"
          iconSize={14}
          formatter={(value: string) => (
            <span className="text-[10px] text-content-muted">{LABELS[value] ?? value}</span>
          )}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const LABELS: Record<string, string> = {
  demand: 'Demand',
  used: 'Delivered',
  allocated: 'Allocated',
  capacity: 'Capacity',
  latency: 'Latency',
  loss: 'Packet loss',
  cpu: 'CPU',
  memory: 'Memory',
  jitter: 'Jitter',
};

/** Generic multi-series line chart, used for latency, loss and compute panels. */
export function MetricChart({
  data,
  series,
  unit,
  height = 160,
  yFormatter,
}: {
  data: TimePoint[];
  series: { key: string; colour: string }[];
  unit?: string;
  height?: number;
  yFormatter?: (value: number) => string;
}): JSX.Element {
  const format = yFormatter ?? ((value: number) => `${value.toFixed(1)}${unit ?? ''}`);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="t" tickFormatter={formatTime} {...AXIS} minTickGap={48} />
        <YAxis tickFormatter={format} {...AXIS} width={52} />

        <RechartsTooltip
          {...tooltipStyle()}
          labelFormatter={(value) => formatTime(Number(value))}
          formatter={(value: number, name: string) => [format(value), LABELS[name] ?? name]}
        />

        {series.map((entry) => (
          <Line
            key={entry.key}
            type="monotone"
            dataKey={entry.key}
            stroke={entry.colour}
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
        ))}

        {series.length > 1 && (
          <Legend
            verticalAlign="top"
            height={22}
            iconType="plainline"
            iconSize={12}
            formatter={(value: string) => (
              <span className="text-[10px] text-content-muted">{LABELS[value] ?? value}</span>
            )}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
