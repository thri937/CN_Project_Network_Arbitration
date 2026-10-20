import { useState, useEffect, useRef, useCallback } from 'react';
import type { SliceSnapshot, BoundDevice, ChartSample } from '../types';
import { formatKbps, formatMs } from '../utils/format';
import { ThroughputChart } from './ThroughputChart';
import { LatencyChart } from './LatencyChart';
import { SlaStatusGrid } from './SlaStatusGrid';
import { ChartErrorBoundary } from './ChartErrorBoundary';

interface Props {
  device: BoundDevice;
  onLeave: () => void;
}

export function SlicePage({ device, onLeave }: Props) {
  const [snapshot, setSnapshot] = useState<SliceSnapshot | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [demandRate, setDemandRate] = useState<number>(0);
  const [trafficMode, setTrafficMode] = useState<'local' | 'internet'>('local');
  const [history, setHistory] = useState<ChartSample[]>([]);
  const [streamingActive, setStreamingActive] = useState(false);
  const [streamBytes, setStreamBytes] = useState(0);

  const abortControllerRef = useRef<AbortController | null>(null);
  const probeSeqRef = useRef<number>(1);
  const probeBufferRef = useRef<Array<{ seq: number; sentAtMs: number; recvAtMs: number; rttMs: number }>>([]);

  // Fetch initial snapshot
  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch(`/portal-api/snapshot?device=${device.deviceId}`);
      if (res.ok) {
        const data: SliceSnapshot = await res.json();
        setSnapshot(data);
        if (demandRate === 0 && data.slice) {
          // Initialize slider to normal (55% of baseline)
          setDemandRate(Math.round(data.slice.baselineKbps * 0.55));
        }
      } else if (res.status === 404 || res.status === 403) {
        // Device session expired or gateway restarted - return to join screen cleanly
        onLeave();
      }
    } catch {
      // ignore
    }
  }, [device.deviceId, demandRate, onLeave]);

  // Connect WebSocket for live 1-second snapshots & operator override
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?device=${device.deviceId}`;
    let ws: WebSocket | null = null;
    let reconnectTimeout: any = null;

    const connect = () => {
      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setWsConnected(true);
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'snapshot') {
              const snap = msg.data as SliceSnapshot;
              setSnapshot(snap);

              // Update history for graphs
              const now = new Date();
              const timeStr = `${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
              setHistory((prev) => {
                const sample: ChartSample = {
                  time: timeStr,
                  demandKbps: snap.stats.demandKbps,
                  limitKbps: snap.stats.limitKbps,
                  usedKbps: snap.stats.usedKbps,
                  droppedKbps: snap.stats.droppedKbps,
                  latencyMs: snap.stats.latencyP95Ms ?? 0,
                  jitterMs: snap.stats.jitterMs ?? 0,
                  lossPct: snap.stats.lossPct,
                };
                const updated = [...prev, sample];
                return updated.length > 60 ? updated.slice(updated.length - 60) : updated;
              });
            } else if (msg.type === 'operator-demand') {
              // Remote override from operator in dashboard!
              setDemandRate(msg.rateKbps);
              if (msg.mode) setTrafficMode(msg.mode);
            }
          } catch {
            // ignore
          }
        };

        ws.onclose = () => {
          setWsConnected(false);
          reconnectTimeout = setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          ws?.close();
        };
      } catch {
        setWsConnected(false);
        reconnectTimeout = setTimeout(connect, 3000);
      }
    };

    connect();
    fetchSnapshot();

    return () => {
      clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [device.deviceId, fetchSnapshot]);

  // Periodic client-side active RTT probing every 1000ms
  useEffect(() => {
    const probeInterval = setInterval(async () => {
      const seq = probeSeqRef.current++;
      const sentAt = Date.now();
      try {
        const res = await fetch(`/probe?device=${device.deviceId}&seq=${seq}`, {
          cache: 'no-store',
        });
        if (res.ok) {
          const recvAt = Date.now();
          const rtt = Math.max(1, recvAt - sentAt);
          probeBufferRef.current.push({
            seq,
            sentAtMs: sentAt,
            recvAtMs: recvAt,
            rttMs: rtt,
          });
        }
      } catch {
        // probe failed or dropped
      }
    }, 1000);

    // Flush probe buffer to gateway every 3 seconds
    const flushInterval = setInterval(async () => {
      if (probeBufferRef.current.length > 0) {
        const batch = [...probeBufferRef.current];
        probeBufferRef.current = [];
        try {
          await fetch('/portal-api/probe-results', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceId: device.deviceId,
              results: batch,
            }),
          });
        } catch {
          // ignore
        }
      }
    }, 3000);

    return () => {
      clearInterval(probeInterval);
      clearInterval(flushInterval);
    };
  }, [device.deviceId]);

  // Stream load based on demandRate
  const startLoadStreaming = useCallback((rate: number, mode: 'local' | 'internet') => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (rate <= 0) {
      setStreamingActive(false);
      return;
    }

    const abort = new AbortController();
    abortControllerRef.current = abort;
    setStreamingActive(true);

    fetch(`/load/down?device=${device.deviceId}&rate=${rate}&mode=${mode}`, {
      signal: abort.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok || !response.body) {
          throw new Error('Failed to start load stream');
        }
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            setStreamBytes((prev) => prev + value.length);
          }
        }
        setStreamingActive(false);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          console.error('Load stream error:', err);
        }
        setStreamingActive(false);
      });
  }, [device.deviceId]);

  // Handle demand rate or traffic mode change
  useEffect(() => {
    if (demandRate > 0) {
      startLoadStreaming(demandRate, trafficMode);
    } else {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      setStreamingActive(false);
    }

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [demandRate, trafficMode, startLoadStreaming]);

  if (!snapshot) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center text-slate-400">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500 mb-4" />
        <p>Connecting to {device.sliceCode} slice runtime...</p>
      </div>
    );
  }

  const slice = snapshot.slice || {
    code: device?.sliceCode || 'slice',
    name: 'Network Slice',
    department: 'Operations',
    profile: 'eMBB' as const,
    baselineKbps: 140,
    floorKbps: 28,
    burstKbps: 200,
    currentLimitKbps: 140,
    slaTargets: { latencyMs: 300, jitterMs: 50, lossPct: 5, minThroughputKbps: 10, availabilityPct: 99.0 },
    joinCode: 'JOIN',
  };
  const stats = snapshot.stats || {
    code: slice.code,
    atMs: Date.now(),
    demandKbps: 0,
    limitKbps: slice.baselineKbps,
    usedKbps: 0,
    droppedKbps: 0,
    queueMs: 0,
    latencyP50Ms: null,
    latencyP95Ms: null,
    jitterMs: null,
    lossPct: 0,
    availabilityPct: null,
    activeDevices: 1,
    activeSessions: 0,
    saturated: false,
  };
  const state = snapshot.state || 'NORMAL';
  const degradationPct = snapshot.degradationPct || 0;
  const latestDecision = snapshot.latestDecision;
  const isDegraded = state === 'DEGRADED';
  const isProtected = state === 'PROTECTED';
  const baselineKbps = slice.baselineKbps || 140;
  const maxSliderValue = baselineKbps * 2;

  // Preset ratios: Idle (0), Light (0.3), Normal (0.55), Busy (0.8), Peak (1.0), Flood (2.0)
  const presets = [
    { label: 'Idle (0%)', value: 0 },
    { label: 'Light (30%)', value: Math.round(baselineKbps * 0.3) },
    { label: 'Normal (55%)', value: Math.round(baselineKbps * 0.55) },
    { label: 'Busy (80%)', value: Math.round(baselineKbps * 0.8) },
    { label: 'Peak (100%)', value: baselineKbps },
    { label: 'Flood (200%)', value: baselineKbps * 2 },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-800/60 border border-slate-700/60 rounded-2xl p-4 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/40 flex items-center justify-center font-bold text-blue-400">
            {slice.profile}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-100">{slice.name}</h1>
              <span className="text-xs px-2 py-0.5 rounded font-mono bg-slate-900 border border-slate-700 text-blue-400">
                {slice.joinCode}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-400 mt-0.5">
              <span>Department: <b className="text-slate-300">{slice.department}</b></span>
              <span>•</span>
              <span>Device: <b className="text-slate-300">{device.nickname}</b></span>
              <span>•</span>
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                {wsConnected ? 'Realtime WS' : 'Connecting'}
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onLeave}
          className="px-3.5 py-1.5 bg-slate-700/60 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-semibold transition border border-slate-600/60"
        >
          Switch Slice
        </button>
      </div>

      {/* Degradation / Protection Banner */}
      {isDegraded && (
        <div className="p-4 bg-amber-950/60 border border-amber-600/70 rounded-2xl text-amber-200 shadow-lg flex items-start gap-3">
          <span className="text-2xl leading-none mt-0.5">⚠️</span>
          <div>
            <div className="font-bold text-sm tracking-wide text-amber-300 uppercase">
              Degraded by CBHA Arbitration (−{degradationPct}%)
            </div>
            <div className="text-xs mt-1 text-amber-200/90 leading-relaxed">
              Link is in contention. Controller lowered this slice limit from <b>{formatKbps(slice.baselineKbps)}</b> to <b>{formatKbps(stats.limitKbps)}</b> (floor: {formatKbps(slice.floorKbps)}).
              {latestDecision && (
                <span className="block mt-1 font-mono text-[11px] text-amber-400/90">
                  Decision #{latestDecision.decisionId}: {latestDecision.reason}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {isProtected && (
        <div className="p-4 bg-emerald-950/50 border border-emerald-600/60 rounded-2xl text-emerald-200 shadow-lg flex items-start gap-3">
          <span className="text-2xl leading-none mt-0.5">🛡️</span>
          <div>
            <div className="font-bold text-sm tracking-wide text-emerald-300 uppercase">
              Protected by CBHA Arbitration (+{formatKbps(stats.limitKbps)})
            </div>
            <div className="text-xs mt-1 text-emerald-200/90">
              High business criticality protected under congestion. Mission-critical SLAs guaranteed.
            </div>
          </div>
        </div>
      )}

      {/* Limit & Allocation Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className={`p-4 rounded-xl border ${isDegraded ? 'bg-amber-950/20 border-amber-600/50' : 'bg-slate-800/60 border-slate-700/60'}`}>
          <span className="text-xs text-slate-400 font-medium block">Current Limit</span>
          <span className={`text-2xl font-black mt-1 block ${isDegraded ? 'text-amber-400' : 'text-slate-100'}`}>
            {formatKbps(stats.limitKbps)}
          </span>
          <span className="text-[11px] text-slate-500 mt-1 block">
            Baseline: {formatKbps(slice.baselineKbps)}
          </span>
        </div>

        <div className="p-4 rounded-xl border bg-slate-800/60 border-slate-700/60">
          <span className="text-xs text-slate-400 font-medium block">Carried Load</span>
          <span className="text-2xl font-black text-emerald-400 mt-1 block">
            {formatKbps(stats.usedKbps)}
          </span>
          <span className="text-[11px] text-slate-500 mt-1 block">
            Demand: {formatKbps(stats.demandKbps)}
          </span>
        </div>

        <div className="p-4 rounded-xl border bg-slate-800/60 border-slate-700/60">
          <span className="text-xs text-slate-400 font-medium block">Queueing Latency</span>
          <span className="text-2xl font-black text-purple-400 mt-1 block">
            {formatMs(stats.queueMs)}
          </span>
          <span className="text-[11px] text-slate-500 mt-1 block">
            RTT P95: {formatMs(stats.latencyP95Ms)}
          </span>
        </div>

        <div className="p-4 rounded-xl border bg-slate-800/60 border-slate-700/60">
          <span className="text-xs text-slate-400 font-medium block">Contractual Floor</span>
          <span className="text-2xl font-black text-slate-300 mt-1 block">
            {formatKbps(slice.floorKbps)}
          </span>
          <span className="text-[11px] text-slate-500 mt-1 block">
            Burst Max: {formatKbps(slice.burstKbps)}
          </span>
        </div>
      </div>

      {/* Demand Generation Control Panel */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-5 shadow-lg space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/60 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-100">Client Traffic Generator</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Generates genuine real-network load against the gateway shaper at <code>/load/down</code>.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Mode:</span>
            <div className="flex rounded-lg bg-slate-900 border border-slate-700 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setTrafficMode('local')}
                className={`px-3 py-1 rounded-md font-semibold transition ${trafficMode === 'local' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                Local Shaper
              </button>
              <button
                type="button"
                onClick={() => setTrafficMode('internet')}
                className={`px-3 py-1 rounded-md font-semibold transition ${trafficMode === 'internet' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                Internet Proxy
              </button>
            </div>
          </div>
        </div>

        {/* Presets */}
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
            Load Presets
          </label>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {presets.map((p) => {
              const active = demandRate === p.value;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setDemandRate(p.value)}
                  className={`py-2 px-2 text-xs font-semibold rounded-xl border text-center transition ${
                    active
                      ? 'bg-blue-600 border-blue-500 text-white shadow-md shadow-blue-900/30 ring-1 ring-blue-400'
                      : 'bg-slate-900/70 border-slate-700/60 text-slate-300 hover:bg-slate-700/60'
                  }`}
                >
                  <div className="truncate">{p.label}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">{formatKbps(p.value)}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Interactive Slider */}
        <div className="space-y-2 pt-2">
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-400 font-semibold uppercase tracking-wider">
              Fine Rate Adjustment:
            </span>
            <span className="font-mono text-sm font-bold text-blue-400">
              {formatKbps(demandRate)} ({Math.round((demandRate / baselineKbps) * 100)}% of baseline)
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={maxSliderValue}
            step={Math.max(1, Math.round(baselineKbps / 100))}
            value={demandRate}
            onChange={(e) => setDemandRate(parseInt(e.target.value, 10))}
            className="w-full h-2 bg-slate-900 rounded-lg appearance-none cursor-pointer accent-blue-500"
          />

          <div className="flex justify-between text-[11px] text-slate-500 font-mono">
            <span>0 kbps (Idle)</span>
            <span>{formatKbps(baselineKbps)} (100% Baseline)</span>
            <span>{formatKbps(maxSliderValue)} (200% Flood)</span>
          </div>
        </div>

        {/* Live Streaming State */}
        <div className="flex items-center justify-between p-3 rounded-xl bg-slate-900/70 border border-slate-800 text-xs">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${streamingActive ? 'bg-emerald-400 animate-ping' : 'bg-slate-600'}`} />
            <span className="font-semibold text-slate-200">
              {streamingActive ? `Streaming real traffic at ${formatKbps(demandRate)}` : 'Load Generator Idle'}
            </span>
          </div>
          <div className="font-mono text-slate-400">
            Transferred: {(streamBytes / 1024 / 1024).toFixed(2)} MB
          </div>
        </div>
      </div>

      {/* SLA Target Metrics Comparison */}
      <div className="space-y-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1">
          Measured SLA Performance vs Contractual Targets
        </h2>
        <SlaStatusGrid snapshot={snapshot} />
      </div>

      {/* Realtime Graphs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartErrorBoundary title="Throughput vs Limit">
          <ThroughputChart data={history} />
        </ChartErrorBoundary>
        <ChartErrorBoundary title="Latency & Jitter">
          <LatencyChart data={history} targetLatencyMs={slice?.slaTargets?.latencyMs ?? 300} />
        </ChartErrorBoundary>
      </div>
    </div>
  );
}
