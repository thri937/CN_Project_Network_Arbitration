import { useState, useEffect } from 'react';
import type { BoundDevice } from './types';
import { JoinPage } from './components/JoinPage';
import { SlicePage } from './components/SlicePage';

export default function App() {
  const [device, setDevice] = useState<BoundDevice | null>(() => {
    try {
      const stored = localStorage.getItem('cn_bound_device');
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
      fetch(`/portal-api/snapshots?device=${deviceIdParam}`)
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
          localStorage.setItem('cn_bound_device', JSON.stringify(bound));
          setDevice(bound);
        })
        .catch(() => {
          // ignore
        });
    }
  }, [device]);

  const handleJoined = (bound: BoundDevice) => {
    localStorage.setItem('cn_bound_device', JSON.stringify(bound));
    setDevice(bound);
    window.history.replaceState({}, '', `?device=${bound.deviceId}`);
  };

  const handleLeave = () => {
    localStorage.removeItem('cn_bound_device');
    setDevice(null);
    window.history.replaceState({}, '', '/');
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col justify-between">
      <main className="flex-1">
        {device ? (
          <SlicePage device={device} onLeave={handleLeave} />
        ) : (
          <JoinPage onJoined={handleJoined} />
        )}
      </main>

      <footer className="py-4 text-center text-xs text-slate-500 border-t border-slate-800">
        Real-Network 5G CBHA Arbitration Testbed • Edge Slice Gateway Portal
      </footer>
    </div>
  );
}
