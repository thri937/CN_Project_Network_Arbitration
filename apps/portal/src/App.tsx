import { useEffect, useState } from 'react';
import type { BoundDevice } from './types';
import { JoinPage } from './components/JoinPage';
import { SlicePage } from './components/SlicePage';
import { ErrorBoundary } from './components/ErrorBoundary';

// The joined slice lives in sessionStorage, which is separate for every browser tab, so several
// tabs on one laptop can each be a different department. The nickname is kept in localStorage.
const DEVICE_KEY = 'cn_bound_device';
const CODE_KEY = 'cn_join_code';

function readStored(): BoundDevice | null {
  try {
    const stored = sessionStorage.getItem(DEVICE_KEY);
    return stored ? (JSON.parse(stored) as BoundDevice) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [device, setDevice] = useState<BoundDevice | null>(readStored);

  // A link with ?device=… (the address bar after joining) restores that device in a new tab.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('device');
    if (!id || device?.deviceId === id) return;
    fetch(`/portal-api/snapshot?device=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('not found'))))
      .then((snap) => {
        const bound: BoundDevice = {
          deviceId: id,
          sliceCode: snap.slice.code,
          nickname: localStorage.getItem('cn_device_nickname') || 'Device',
          sourceIp: '',
          lastSeenMs: Date.now(),
          activeRateKbps: 0,
          mode: 'local',
          operatorControlEnabled: true,
        };
        sessionStorage.setItem(DEVICE_KEY, JSON.stringify(bound));
        setDevice(bound);
      })
      .catch(() => window.history.replaceState({}, '', '/join'));
  }, [device]);

  const joined = (bound: BoundDevice, joinCode?: string) => {
    sessionStorage.setItem(DEVICE_KEY, JSON.stringify(bound));
    if (joinCode) sessionStorage.setItem(CODE_KEY, joinCode);
    setDevice(bound);
    window.history.replaceState({}, '', `/slice?device=${bound.deviceId}`);
  };

  // The gateway restarted and forgot this device: join the same slice again without asking.
  const lost = async () => {
    const code = sessionStorage.getItem(CODE_KEY);
    if (!code || !device) return leave();
    try {
      const res = await fetch('/portal-api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, nickname: device.nickname }),
      });
      if (!res.ok) return leave();
      const body = await res.json();
      joined({ ...device, deviceId: body.deviceId, sliceCode: body.slice?.code ?? device.sliceCode }, code);
    } catch {
      leave();
    }
  };

  const leave = () => {
    sessionStorage.removeItem(DEVICE_KEY);
    sessionStorage.removeItem(CODE_KEY);
    setDevice(null);
    window.history.replaceState({}, '', '/join');
  };

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <ErrorBoundary>
        {device ? (
          <SlicePage key={device.deviceId} device={device} onLeave={leave} onLost={() => void lost()} />
        ) : (
          <JoinPage onJoined={joined} />
        )}
      </ErrorBoundary>
    </div>
  );
}
