import type { SliceSnapshot } from '../types';
import { formatMs, formatPercent, formatKbps } from '../utils/format';

interface Props {
  snapshot: SliceSnapshot;
}

export function SlaStatusGrid({ snapshot }: Props) {
  const { stats, slice } = snapshot;
  const targets = slice?.slaTargets || {
    latencyMs: 300,
    jitterMs: 50,
    lossPct: 5,
    minThroughputKbps: 50,
    availabilityPct: 99.0,
  };

  const latencyOk = stats.latencyP95Ms === null || stats.latencyP95Ms <= (targets.latencyMs ?? 300);
  const jitterOk = stats.jitterMs === null || stats.jitterMs <= (targets.jitterMs ?? 50);
  const lossOk = stats.lossPct <= (targets.lossPct ?? 5);
  const availOk = stats.availabilityPct === null || stats.availabilityPct >= (targets.availabilityPct ?? 99);
  const throughputOk = stats.usedKbps >= (targets.minThroughputKbps ?? 0) || stats.demandKbps < (targets.minThroughputKbps ?? 0);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {/* Latency */}
      <div className={`p-3 rounded-xl border ${latencyOk ? 'bg-slate-800/60 border-slate-700/60' : 'bg-red-950/30 border-red-800/50'}`}>
        <div className="text-xs text-slate-400 font-medium">Latency P95</div>
        <div className={`text-lg font-bold mt-1 ${latencyOk ? 'text-slate-100' : 'text-red-400'}`}>
          {formatMs(stats.latencyP95Ms)}
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          Target: &lt; {targets.latencyMs} ms
        </div>
      </div>

      {/* Jitter */}
      <div className={`p-3 rounded-xl border ${jitterOk ? 'bg-slate-800/60 border-slate-700/60' : 'bg-red-950/30 border-red-800/50'}`}>
        <div className="text-xs text-slate-400 font-medium">Jitter (RFC 3550)</div>
        <div className={`text-lg font-bold mt-1 ${jitterOk ? 'text-slate-100' : 'text-red-400'}`}>
          {formatMs(stats.jitterMs)}
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          Target: &lt; {targets.jitterMs} ms
        </div>
      </div>

      {/* Packet Loss */}
      <div className={`p-3 rounded-xl border ${lossOk ? 'bg-slate-800/60 border-slate-700/60' : 'bg-red-950/30 border-red-800/50'}`}>
        <div className="text-xs text-slate-400 font-medium">Packet Loss</div>
        <div className={`text-lg font-bold mt-1 ${lossOk ? 'text-slate-100' : 'text-red-400'}`}>
          {formatPercent(stats.lossPct)}
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          Target: &lt; {targets.lossPct}%
        </div>
      </div>

      {/* Throughput */}
      <div className={`p-3 rounded-xl border ${throughputOk ? 'bg-slate-800/60 border-slate-700/60' : 'bg-yellow-950/30 border-yellow-800/50'}`}>
        <div className="text-xs text-slate-400 font-medium">Throughput</div>
        <div className="text-lg font-bold mt-1 text-slate-100">
          {formatKbps(stats.usedKbps)}
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          Guaranteed: {formatKbps(targets.minThroughputKbps)}
        </div>
      </div>

      {/* Availability */}
      <div className={`p-3 rounded-xl border ${availOk ? 'bg-slate-800/60 border-slate-700/60' : 'bg-red-950/30 border-red-800/50'} col-span-2 sm:col-span-1`}>
        <div className="text-xs text-slate-400 font-medium">Availability</div>
        <div className={`text-lg font-bold mt-1 ${availOk ? 'text-slate-100' : 'text-red-400'}`}>
          {formatPercent(stats.availabilityPct)}
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          Target: &gt; {targets.availabilityPct}%
        </div>
      </div>
    </div>
  );
}
