import { useEffect, useState } from 'react';
import type { BoundDevice, SliceCatalogueItem } from '../types';
import { formatKbps, profileLabel } from '../utils/format';

interface Props {
  onJoined: (device: BoundDevice, joinCode: string) => void;
}

export function JoinPage({ onJoined }: Props) {
  const [slices, setSlices] = useState<SliceCatalogueItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState(() => (new URLSearchParams(window.location.search).get('code') ?? '').trim().toUpperCase());
  const [nickname, setNickname] = useState(() => localStorage.getItem('cn_device_nickname') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/portal-api/slices')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`gateway answered ${res.status}`))))
      .then((data: SliceCatalogueItem[]) =>
        // CLN101 … CAN701: the digits follow the department order (most critical first).
        setSlices([...data].sort((a, b) => a.joinCode.replace(/\D/g, '').localeCompare(b.joinCode.replace(/\D/g, '')))),
      )
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  const match = slices.find((s) => s.joinCode?.toUpperCase() === code.trim().toUpperCase());

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setError('Enter your department’s join code.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/portal-api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim().toUpperCase(), nickname: nickname.trim() || 'Phone' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not join');
      localStorage.setItem('cn_device_nickname', nickname.trim());
      onJoined({
        deviceId: body.deviceId,
        sliceCode: body.slice?.code ?? '',
        nickname: nickname.trim() || 'Phone',
        sourceIp: '',
        lastSeenMs: Date.now(),
        activeRateKbps: 0,
        mode: 'local',
        operatorControlEnabled: true,
      }, code.trim().toUpperCase());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md px-5 py-8">
      <h1 className="text-xl font-semibold">Join your department’s slice</h1>
      <p className="mt-1 text-sm text-gray-600">
        This device becomes one department on the testbed’s shared 1 Mbps link. You choose how much traffic to send on the
        next screen.
      </p>

      {loadError && (
        <p className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Cannot reach the gateway ({loadError}). Check this phone is on the laptop’s hotspot.
        </p>
      )}

      <form onSubmit={join} className="mt-6 space-y-4">
        <label className="block text-sm">
          <span className="text-gray-700">Join code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={6}
            autoCapitalize="characters"
            autoComplete="off"
            placeholder="e.g. CLN101"
            className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 font-mono text-base tracking-wider focus:border-blue-600 focus:outline-none"
          />
        </label>

        {match && (
          <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
            <div className="font-medium">
              {match.department}: {match.name}
            </div>
            <div className="text-gray-600">
              {profileLabel(match.profile)} · limit {formatKbps(match.baselineKbps)} · floor {formatKbps(match.floorKbps)} ·
              latency target {match.slaTargets.latencyMs} ms
            </div>
          </div>
        )}

        <label className="block text-sm">
          <span className="text-gray-700">Name for this device (shown on the dashboard)</span>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={32}
            placeholder="e.g. Ravi’s phone"
            className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-base focus:border-blue-600 focus:outline-none"
          />
        </label>

        {error && <p className="text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="w-full rounded bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Joining…' : match ? `Join ${match.department}` : 'Join'}
        </button>
      </form>

      {slices.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-gray-700">Departments</h2>
          <ul className="mt-2 divide-y divide-gray-200 rounded border border-gray-200 text-sm">
            {slices.map((s) => (
              <li key={s.code}>
                <button
                  type="button"
                  onClick={() => setCode(s.joinCode.toUpperCase())}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left ${match?.code === s.code ? 'bg-blue-50' : ''}`}
                >
                  <span>
                    {s.department} <span className="text-gray-500">· {s.name}</span>
                  </span>
                  <span className="font-mono text-gray-600">{s.joinCode}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
