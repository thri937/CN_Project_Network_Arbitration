import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts';
import type { ChartSample } from '../types';

interface Props {
  data: ChartSample[];
  targetLatencyMs?: number;
}

export function LatencyChart({ data, targetLatencyMs = 300 }: Props) {
  return (
    <div className="w-full h-64 bg-slate-800/60 rounded-xl p-3 border border-slate-700/60 flex flex-col">
      <div className="flex justify-between items-center mb-2 px-1">
        <h3 className="text-sm font-semibold text-slate-200">Latency & Jitter</h3>
        <span className="text-xs text-slate-400">Target: {targetLatencyMs} ms</span>
      </div>
      <div className="flex-1 w-full min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <XAxis dataKey="time" stroke="#64748b" fontSize={11} tickLine={false} />
            <YAxis stroke="#64748b" fontSize={11} tickLine={false} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1e293b',
                borderColor: '#334155',
                borderRadius: '8px',
                fontSize: '12px',
              }}
            />
            <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '4px' }} />
            <Line
              type="monotone"
              dataKey="latencyMs"
              name="RTT P95 (ms)"
              stroke="#a855f7"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="jitterMs"
              name="Jitter (ms)"
              stroke="#06b6d4"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
