import { useState, useEffect } from 'react';
import type { BoundDevice } from './types';
import { JoinPage } from './components/JoinPage';
import { SlicePage } from './components/SlicePage';
import { ErrorBoundary } from './components/ErrorBoundary';

// The bound device lives in sessionStorage, which is separate for every tab, so several tabs on
// one laptop can each join a different slice. The nickname stays in localStorage as a convenience.
const DEVICE_KEY = 'cn_bound_device';

export default function App() {
  const [device, setDevice] = useState<BoundDevice | null>(() => {
    try {
      const stored = sessionStorage.getItem(DEVICE_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    // If URL has ?device=... but not in state, attempt to load device
    const params = new URLSearchParams(window.location.search);
    const deviceIdParam = params.get('device');
    if (deviceIdParam && (!device || device.deviceId !== deviceIdParam)) {
      fetch(`/portal-api/snapshot?device=${deviceIdParam}`)
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error('Not found');
        })
        .then((snap) => {
          const bound: BoundDevice = {
            deviceId: deviceIdParam,
            sliceCode: snap.slice.code,
            nickname: localStorage.getItem('cn_device_nickname') || 'Client Device',
            sourceIp: '127.0.0.1',
            lastSeenMs: Date.now(),
            activeRateKbps: 0,
            mode: 'local',
            operatorControlEnabled: true,
          };
          sessionStorage.setItem(DEVICE_KEY, JSON.stringify(bound));
          setDevice(bound);
        })
        .catch(() => {
          // ignore
        });
    }
  }, [device]);

  const handleJoined = (bound: BoundDevice) => {
    sessionStorage.setItem(DEVICE_KEY, JSON.stringify(bound));
    setDevice(bound);
    window.history.replaceState({}, '', `?device=${bound.deviceId}`);
  };

  const handleLeave = () => {
    sessionStorage.removeItem(DEVICE_KEY);
    setDevice(null);
    window.history.replaceState({}, '', '/');
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col justify-between">
      <main className="flex-1">
        <ErrorBoundary>
          {device ? (
            <SlicePage device={device} onLeave={handleLeave} />
          ) : (
            <JoinPage onJoined={handleJoined} />
          )}
        </ErrorBoundary>
      </main>

      <footer className="py-4 text-center text-xs text-slate-500 border-t border-slate-800">
        Real-Network 5G CBHA Arbitration Testbed • Edge Slice Gateway Portal
      </footer>
    </div>
  );
}
