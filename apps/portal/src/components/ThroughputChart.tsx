import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts';
import type { ChartSample } from '../types';

interface Props {
  data: ChartSample[];
}

export function ThroughputChart({ data }: Props) {
  if (!data || data.length === 0) {
    return (
      <div className="w-full h-64 bg-slate-800/60 rounded-xl p-3 border border-slate-700/60 flex flex-col items-center justify-center text-slate-500 text-xs">
        <span className="mb-1 text-base">📊</span>
        <span>Awaiting realtime throughput samples...</span>
      </div>
    );
  }

  return (
    <div className="w-full h-64 bg-slate-800/60 rounded-xl p-3 border border-slate-700/60 flex flex-col">
      <div className="flex justify-between items-center mb-2 px-1">
        <h3 className="text-sm font-semibold text-slate-200">Throughput vs Limit</h3>
        <span className="text-xs text-slate-400">Past 60 seconds (kbps)</span>
      </div>
      <div className="flex-1 w-full min-h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorUsed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
              </linearGradient>
              <linearGradient id="colorDemand" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.0} />
              </linearGradient>
            </defs>
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
            <Area
              type="monotone"
              dataKey="demandKbps"
              name="Demand"
              stroke="#3b82f6"
              fill="url(#colorDemand)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="usedKbps"
              name="Carried (Used)"
              stroke="#10b981"
              fill="url(#colorUsed)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Area
              type="stepAfter"
              dataKey="limitKbps"
              name="Limit"
              stroke="#f59e0b"
              fill="none"
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={false}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="droppedKbps"
              name="Dropped"
              stroke="#ef4444"
              fill="none"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
