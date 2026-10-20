import { useCallback, useEffect, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { BoundDevice, SliceSnapshot } from '../types';
import { formatKbps, formatMs, formatPercent, profileLabel } from '../utils/format';

interface Props {
  device: BoundDevice;
  /** The operator removed this device: back to the join page. */
  onLeave: () => void;
  /** The gateway no longer knows this device (it restarted): join again. */
  onLost: () => void;
}

interface Point {
  t: string;
  demand: number;
  limit: number;
  carried: number;
  latency: number | null;
}

const PRESETS = [
  { label: 'Idle', fraction: 0 },
  { label: 'Light 30 %', fraction: 0.3 },
  { label: 'Normal 55 %', fraction: 0.55 },
  { label: 'Busy 80 %', fraction: 0.8 },
  { label: 'Peak 100 %', fraction: 1 },
  { label: 'Flood 200 %', fraction: 2 },
];

export function SlicePage({ device, onLeave, onLost }: Props) {
  // Callbacks from the parent change identity on every render; keep the latest in refs so the
  // live connection is not torn down and rebuilt each time.
  const onLeaveRef = useRef(onLeave);
  const onLostRef = useRef(onLost);
  onLeaveRef.current = onLeave;
  onLostRef.current = onLost;

  const [snapshot, setSnapshot] = useState<SliceSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [rate, setRate] = useState(0); // demand being sent, kbps
  const [draft, setDraft] = useState(0); // slider position while dragging
  const [mode, setMode] = useState<'local' | 'internet'>('local');
  const [received, setReceived] = useState(0); // bytes since joining
  const [streaming, setStreaming] = useState(false);
  const [history, setHistory] = useState<Point[]>([]);
  const [operatorNote, setOperatorNote] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  const probeSeq = useRef(1);
  const probeBuffer = useRef<{ seq: number; sentAtMs: number; recvAtMs: number; rttMs: number }[]>([]);

  const applySnapshot = useCallback((snap: SliceSnapshot) => {
    if (!snap?.slice || !snap.stats) return;
    setSnapshot(snap);
    // Start at Normal (55 % of baseline) once, when the slice is first known.
    if (!startedRef.current) {
      startedRef.current = true;
      const normal = Math.round(snap.slice.baselineKbps * 0.55);
      setRate(normal);
      setDraft(normal);
    }
    const now = new Date();
    const t = `${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    setHistory((prev) =>
      [
        ...prev,
        {
          t,
          demand: snap.stats.demandKbps,
          limit: snap.stats.limitKbps,
          carried: snap.stats.usedKbps,
          latency: snap.stats.latencyP95Ms,
        },
      ].slice(-90),
    );
  }, []);

  // Snapshot over HTTP: on load, and after every reconnect. If the gateway no longer knows this
  // device (it restarted), join again.
  const checkDevice = useCallback(() => {
    fetch(`/portal-api/snapshot?device=${encodeURIComponent(device.deviceId)}`)
      .then((res) => {
        if (res.status === 404 || res.status === 403) {
          onLostRef.current();
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((snap) => snap && applySnapshot(snap))
      .catch(() => undefined);
  }, [device.deviceId, applySnapshot]);

  useEffect(() => checkDevice(), [checkDevice]);

  // Live updates once a second, and operator commands from the dashboard.
  useEffect(() => {
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws?device=${encodeURIComponent(device.deviceId)}`;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      ws = new WebSocket(url);
      ws.onopen = () => {
        setConnected(true);
        checkDevice();
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'snapshot') applySnapshot(msg.snapshot ?? msg.data);
          if (msg.type === 'operator-demand') {
            setRate(msg.rateKbps);
            setDraft(msg.rateKbps);
            if (msg.mode) setMode(msg.mode);
            setOperatorNote(`The operator set this slice to ${formatKbps(msg.rateKbps)}.`);
          }
          if (msg.type === 'unbound') {
            stopped = true;
            onLeaveRef.current();
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [device.deviceId, applySnapshot, checkDevice]);

  // Latency probes: one a second through this slice's queue, results reported every 3 s.
  useEffect(() => {
    const probe = setInterval(async () => {
      const seq = probeSeq.current++;
      const sentAt = Date.now();
      try {
        const res = await fetch(`/probe?device=${encodeURIComponent(device.deviceId)}&seq=${seq}`, { cache: 'no-store' });
        if (res.ok) {
          const recvAt = Date.now();
          probeBuffer.current.push({ seq, sentAtMs: sentAt, recvAtMs: recvAt, rttMs: Math.max(1, recvAt - sentAt) });
        }
      } catch {
        /* a lost probe counts as loss on the gateway */
      }
    }, 1000);
    const flush = setInterval(() => {
      if (!probeBuffer.current.length) return;
      const results = probeBuffer.current.splice(0);
      fetch('/portal-api/probe-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: device.deviceId, results }),
      }).catch(() => undefined);
    }, 3000);
    return () => {
      clearInterval(probe);
      clearInterval(flush);
    };
  }, [device.deviceId]);

  // The load itself: one download stream at the chosen rate. Restarted when the rate or mode changes.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (rate <= 0) {
      setStreaming(false);
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    setStreaming(true);
    fetch(`/load/down?device=${encodeURIComponent(device.deviceId)}&rate=${rate}&mode=${mode}`, {
      signal: abort.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok || !response.body) throw new Error('stream refused');
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) setReceived((b) => b + value.length);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (abortRef.current === abort) setStreaming(false);
      });
    return () => abort.abort();
  }, [rate, mode, device.deviceId]);

  if (!snapshot) {
    return <div className="mx-auto max-w-md px-5 py-16 text-sm text-gray-600">Connecting to the gateway…</div>;
  }

  const { slice, stats } = snapshot;
  const baseline = slice.baselineKbps;
  const cut = stats.limitKbps < baseline;
  const cutPct = Math.round((1 - stats.limitKbps / baseline) * 100);
  const latencyOver = stats.latencyP95Ms !== null && stats.latencyP95Ms > slice.slaTargets.latencyMs;
  const lossOver = stats.lossPct > slice.slaTargets.lossPct;
  const measured = stats.latencyP95Ms !== null;

  return (
    <div className="mx-auto max-w-2xl space-y-5 px-5 py-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{slice.department}</h1>
          <p className="text-sm text-gray-600">
            {slice.name} · {profileLabel(slice.profile)} · code <span className="font-mono">{slice.joinCode}</span>
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            {device.nickname} · {connected ? 'live' : 'reconnecting…'}
          </p>
        </div>
        <button onClick={() => onLeaveRef.current()} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
          Leave
        </button>
      </header>

      {cut ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <div className="font-medium text-amber-900">
            This slice has been cut by {cutPct} %: limit {formatKbps(stats.limitKbps)} instead of {formatKbps(baseline)}.
          </div>
          {snapshot.latestDecision && <p className="mt-1 text-amber-900/90">{snapshot.latestDecision.reason}</p>}
          <p className="mt-1 text-xs text-amber-800">
            The link is overloaded, and this department costs the least to slow down. It will never go below{' '}
            {formatKbps(slice.floorKbps)}.
          </p>
        </div>
      ) : (
        <div className="rounded border border-gray-200 px-4 py-3 text-sm text-gray-700">
          Running at the full limit of {formatKbps(baseline)}.
        </div>
      )}
      {operatorNote && <p className="text-xs text-gray-500">{operatorNote}</p>}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Limit now" value={formatKbps(stats.limitKbps)} note={`floor ${formatKbps(slice.floorKbps)}`} />
        <Figure label="Getting through" value={formatKbps(stats.usedKbps)} note={`asking for ${formatKbps(stats.demandKbps)}`} />
        <Figure
          label="Latency (p95)"
          value={formatMs(stats.latencyP95Ms)}
          note={`target ${formatMs(slice.slaTargets.latencyMs)}`}
          bad={latencyOver}
        />
        <Figure
          label="Loss"
          value={measured || stats.demandKbps > 0 ? formatPercent(stats.lossPct) : '—'}
          note={`target ${formatPercent(slice.slaTargets.lossPct)}`}
          bad={lossOver}
        />
      </section>

      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-medium">How much traffic to send</h2>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {PRESETS.map((p) => {
            const kbps = Math.round(baseline * p.fraction);
            return (
              <button
                key={p.label}
                onClick={() => {
                  setRate(kbps);
                  setDraft(kbps);
                  setOperatorNote(null);
                }}
                className={`rounded border px-2 py-2 text-xs ${rate === kbps ? 'border-blue-700 bg-blue-50 font-medium' : 'border-gray-300'}`}
              >
                {p.label}
                <span className="block text-[11px] text-gray-500">{formatKbps(kbps)}</span>
              </button>
            );
          })}
        </div>
        <input
          type="range"
          min={0}
          max={baseline * 2}
          step={Math.max(1, Math.round(baseline / 50))}
          value={draft}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={() => setRate(draft)}
          onKeyUp={() => setRate(draft)}
          className="mt-4 w-full accent-blue-700"
          aria-label="Demand in kbps"
        />
        <div className="flex justify-between text-xs text-gray-500">
          <span>0</span>
          <span>
            {formatKbps(draft)} ({Math.round((draft / baseline) * 100)} % of the limit)
          </span>
          <span>{formatKbps(baseline * 2)}</span>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
          <span className="text-gray-600">Bytes come from:</span>
          <label className="flex items-center gap-1">
            <input type="radio" checked={mode === 'local'} onChange={() => setMode('local')} /> the laptop
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={mode === 'internet'} onChange={() => setMode('internet')} /> the internet (uses the laptop’s internet data)
          </label>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          {streaming ? `Sending at ${formatKbps(rate)}.` : 'Not sending.'} Received {(received / 1_000_000).toFixed(2)} MB since
          joining.
        </p>
      </section>

      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-medium">Last 90 seconds</h2>
        <Chart data={history} height={160}>
          <YAxis width={44} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip formatter={(v: number) => formatKbps(v)} />
          <Line dataKey="demand" name="Asking for" stroke="#b45309" dot={false} isAnimationActive={false} />
          <Line dataKey="limit" name="Limit" stroke="#6b7280" strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          <Line dataKey="carried" name="Getting through" stroke="#1d4ed8" strokeWidth={2} dot={false} isAnimationActive={false} />
        </Chart>
        <p className="mt-1 text-xs text-gray-500">Orange: asking for · grey dashed: limit · blue: getting through (kbps)</p>
        <Chart data={history} height={120}>
          <YAxis width={44} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip formatter={(v: number) => formatMs(v)} />
          <ReferenceLine y={slice.slaTargets.latencyMs} stroke="#b91c1c" strokeDasharray="4 3" />
          <Line dataKey="latency" name="Latency p95" stroke="#1d4ed8" dot={false} isAnimationActive={false} connectNulls={false} />
        </Chart>
        <p className="mt-1 text-xs text-gray-500">Latency p95 in ms; the red line is the target.</p>
      </section>
    </div>
  );
}

function Figure({ label, value, note, bad }: { label: string; value: string; note?: string; bad?: boolean }) {
  return (
    <div className="rounded border border-gray-200 px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-base font-semibold ${bad ? 'text-red-700' : ''}`}>{value}</div>
      {note && <div className="text-[11px] text-gray-500">{note}</div>}
    </div>
  );
}

function Chart({ data, height, children }: { data: Point[]; height: number; children: React.ReactNode }) {
  if (data.length < 2) {
    return (
      <div className="grid place-items-center text-xs text-gray-500" style={{ height }}>
        Collecting measurements…
      </div>
    );
  }
  return (
    <div style={{ height }} className="mt-2">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="t" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={30} />
          {children}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
