import { useState, useEffect } from 'react';
import type { SliceCatalogueItem, BoundDevice } from '../types';
import { formatKbps } from '../utils/format';

interface Props {
  onJoined: (device: BoundDevice) => void;
}

export function JoinPage({ onJoined }: Props) {
  const [slices, setSlices] = useState<SliceCatalogueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState(() => localStorage.getItem('cn_device_nickname') || 'My Phone');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check URL search params for ?code=
    const params = new URLSearchParams(window.location.search);
    const codeParam = params.get('code');
    if (codeParam) {
      setCode(codeParam.trim().toUpperCase());
    }

    fetch('/portal-api/slices')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch slice catalogue');
        return res.json();
      })
      .then((data: SliceCatalogueItem[]) => {
        setSlices(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const selectedSlice = slices.find(
    (s) => s.joinCode?.toUpperCase() === code.trim().toUpperCase()
  );

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setError('Please enter a 6-character slice join code');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/portal-api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim().toUpperCase(),
          nickname: nickname.trim() || 'Client Device',
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Failed to join slice');
      }

      localStorage.setItem('cn_device_nickname', nickname.trim());
      const bound: BoundDevice = {
        deviceId: body.deviceId,
        sliceCode: body.slice?.code || code.trim(),
        nickname: nickname.trim() || 'Client Device',
        sourceIp: '127.0.0.1',
        lastSeenMs: Date.now(),
        activeRateKbps: 0,
        mode: 'local',
        operatorControlEnabled: true,
      };
      onJoined(bound);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-blue-950/70 border border-blue-800/60 rounded-full text-blue-400 text-xs font-medium mb-3">
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          Real-Network Slice Gateway
        </div>
        <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight">
          Join a Network Slice
        </h1>
        <p className="text-slate-400 text-sm mt-2">
          Connect your device to a dedicated 5G QoS network slice with enforced token-bucket shaping.
        </p>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-950/60 border border-red-800/80 rounded-xl text-red-200 text-sm flex items-center gap-3">
          <span className="text-xl">⚠️</span>
          <span>{error}</span>
        </div>
      )}

      {/* Join Form */}
      <form onSubmit={handleJoin} className="bg-slate-800/70 border border-slate-700/70 rounded-2xl p-6 shadow-xl space-y-5">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
            Device Nickname
          </label>
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="e.g. Clinic Tablet, Canteen Kiosk"
            className="w-full bg-slate-900/90 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            required
          />
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
            Slice Join Code (6 characters)
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. CLN101"
              className="flex-1 bg-slate-900/90 border border-slate-700 rounded-xl px-4 py-3 font-mono text-lg uppercase tracking-wider text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              required
            />
          </div>
        </div>

        {/* Selected Slice Preview */}
        {selectedSlice && (
          <div className="p-4 bg-slate-900/80 border border-blue-900/50 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs text-blue-400 font-semibold uppercase tracking-wider">
                  {selectedSlice.department}
                </span>
                <h3 className="text-base font-bold text-slate-100 mt-0.5">
                  {selectedSlice.name}
                </h3>
              </div>
              <span className="px-2.5 py-1 bg-blue-950 border border-blue-800 text-blue-300 text-xs font-semibold rounded-lg">
                {selectedSlice.profile}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs pt-2 border-t border-slate-800">
              <div>
                <span className="text-slate-500 block">Baseline Limit</span>
                <span className="font-semibold text-slate-200">{formatKbps(selectedSlice.baselineKbps)}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Floor Limit</span>
                <span className="font-semibold text-slate-200">{formatKbps(selectedSlice.floorKbps)}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Target Latency</span>
                <span className="font-semibold text-slate-200">&lt; {selectedSlice.slaTargets?.latencyMs ?? 300} ms</span>
              </div>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !code.trim()}
          className="w-full py-3.5 px-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50 text-white font-bold rounded-xl transition duration-150 shadow-lg shadow-blue-900/30 text-sm uppercase tracking-wider"
        >
          {submitting ? 'Connecting...' : selectedSlice ? `Join ${selectedSlice.department} Slice` : 'Join Slice'}
        </button>
      </form>

      {/* Available Slices Picker */}
      <div className="mt-8">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 px-1">
          Available Testbed Slices (Click to Select)
        </h2>

        {loading ? (
          <div className="p-8 text-center text-slate-500 text-sm">Loading slice catalogue...</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {slices.map((s) => {
              const sliceJoinCode = s.joinCode || s.code.slice(0, 6).toUpperCase();
              const isSelected = sliceJoinCode === code;
              return (
                <button
                  key={s.code}
                  type="button"
                  onClick={() => setCode(sliceJoinCode)}
                  className={`text-left p-4 rounded-xl border transition duration-150 ${
                    isSelected
                      ? 'bg-blue-950/40 border-blue-500 ring-1 ring-blue-500'
                      : 'bg-slate-800/40 border-slate-700/60 hover:bg-slate-800/80 hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-slate-300">{s.department}</span>
                    <span className="font-mono text-xs font-bold px-2 py-0.5 bg-slate-900 border border-slate-700 rounded text-blue-400">
                      {sliceJoinCode}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-slate-100 truncate">{s.name}</div>
                  <div className="flex items-center justify-between text-xs text-slate-400 mt-2">
                    <span>Baseline: {formatKbps(s.baselineKbps)}</span>
                    <span className="px-1.5 py-0.5 rounded bg-slate-900/80 text-[10px] uppercase font-mono">
                      {s.profile}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
