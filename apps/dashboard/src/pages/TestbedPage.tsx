import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { slicesApi, testbedApi, type TestbedStatus, type TestbedDevice } from '@/api/resources';
import type { Slice } from '@/types/api';
import { useTelemetry, useCapacity } from '@/hooks/useLiveData';
import { Card, CardHeader, CardBody, Badge, Button, PageHeader, Table, Th, Td } from '@/components/ui';
import { Icons } from '@/components/layout/Icons';
import { statusStyles } from '@/lib/format';
import { formatBandwidth } from '@cn/shared';

interface TopologyNode {
  slice: Slice;
  x: number;
  y: number;
  joinCode: string;
}

export function TestbedPage() {
  const [slices, setSlices] = useState<Slice[]>([]);
  const [testbedStatus, setTestbedStatus] = useState<TestbedStatus | null>(null);
  const [devices, setDevices] = useState<TestbedDevice[]>([]);
  const [selectedSlice, setSelectedSlice] = useState<Slice | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [selectedLanIp, setSelectedLanIp] = useState<string>('127.0.0.1');
  const [customDemand, setCustomDemand] = useState<number>(100);
  const [applyingDemand, setApplyingDemand] = useState(false);
  const [runningScenario, setRunningScenario] = useState<string | null>(null);
  const [recordingActive, setRecordingActive] = useState(false);

  // Live telemetry & capacity hooks
  const { data: telemetry } = useTelemetry();
  const { data: capData } = useCapacity();

  // Load initial data and poll devices & testbed status
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [sliceList, status, devList] = await Promise.all([
          slicesApi.list({ limit: 50 }),
          testbedApi.status(),
          testbedApi.devices(),
        ]);
        setSlices(sliceList.items);
        setTestbedStatus(status);
        setDevices(devList);
        setRecordingActive(!!status.activeExperiment);

        // Pick preferred hotspot or LAN IP
        if (status.lanIps && status.lanIps.length > 0) {
          const hotspot = status.lanIps.find((n: { isHotspot: boolean; ip: string }) => n.isHotspot);
          setSelectedLanIp(hotspot ? hotspot.ip : status.lanIps[0]!.ip);
        }
      } catch (e) {
        console.error('Failed to load testbed initial state:', e);
      }
    };

    fetchData();

    const interval = setInterval(async () => {
      try {
        const [status, devList] = await Promise.all([
          testbedApi.status(),
          testbedApi.devices(),
        ]);
        setTestbedStatus(status);
        setDevices(devList);
        setRecordingActive(!!status.activeExperiment);
      } catch {
        // ignore
      }
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  // Update QR Code when selected slice or IP changes
  useEffect(() => {
    if (!selectedSlice) {
      setQrCodeUrl('');
      return;
    }

    const joinTag = selectedSlice.tags.find((t) => t.startsWith('join:'));
    const joinCode = joinTag ? joinTag.slice(5) : selectedSlice.code.slice(0, 6).toUpperCase();
    const portalUrl = `http://${selectedLanIp}:8080/join?code=${joinCode}`;

    QRCode.toDataURL(portalUrl, { width: 220, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } })
      .then((url: string) => setQrCodeUrl(url))
      .catch((err: unknown) => console.error('Failed to generate QR code', err));

    setCustomDemand(selectedSlice.baselineAllocatedMbps);
  }, [selectedSlice, selectedLanIp]);

  // Topology node positioning: 7 slices arranged radially
  const nodeLayout = [
    { x: 450, y: 75 },   // Top (Clinic)
    { x: 610, y: 135 },  // Top-Right (Factory)
    { x: 670, y: 280 },  // Right (Quality Lab)
    { x: 570, y: 420 },  // Bottom-Right (Security)
    { x: 330, y: 420 },  // Bottom-Left (Office)
    { x: 230, y: 280 },  // Left (Warehouse)
    { x: 290, y: 135 },  // Top-Left (Canteen)
  ];

  const topologyNodes: TopologyNode[] = slices.slice(0, 7).map((s, idx) => {
    const coords = nodeLayout[idx] || { x: 450, y: 260 };
    const joinTag = s.tags.find((t) => t.startsWith('join:'));
    const joinCode = joinTag ? joinTag.slice(5) : s.code.slice(0, 6).toUpperCase();
    return {
      slice: s,
      x: coords.x,
      y: coords.y,
      joinCode,
    };
  });

  const handleApplyDemand = async (rate: number) => {
    if (!selectedSlice) return;
    setApplyingDemand(true);
    try {
      await testbedApi.setSliceDemand(selectedSlice.id, rate, 'local');
    } catch (e) {
      console.error('Failed to set remote demand:', e);
    } finally {
      setApplyingDemand(false);
    }
  };

  const handleRunScenario = async (scenarioName: string) => {
    setRunningScenario(scenarioName);
    try {
      await testbedApi.runScenario(scenarioName);
    } catch (e) {
      console.error(`Failed to trigger scenario ${scenarioName}:`, e);
    } finally {
      setTimeout(() => setRunningScenario(null), 1000);
    }
  };

  const handleToggleArbitration = async () => {
    if (!testbedStatus) return;
    const nextState = !testbedStatus.autoArbitration;
    try {
      await testbedApi.setArbitration(nextState);
      setTestbedStatus((prev) => (prev ? { ...prev, autoArbitration: nextState } : null));
    } catch (e) {
      console.error('Failed to toggle arbitration:', e);
    }
  };

  const handleToggleExperiment = async () => {
    try {
      if (recordingActive) {
        await testbedApi.stopExperiment();
        setRecordingActive(false);
      } else {
        await testbedApi.startExperiment('Testbed-Experiment');
        setRecordingActive(true);
      }
    } catch (e) {
      console.error('Failed to toggle experiment recording:', e);
    }
  };

  const bandwidthUnit = testbedStatus?.bandwidthUnit || 'kbps';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Real-Network 5G Slice Testbed"
        description="Physical traffic shaping, token-bucket enforcement, mobile device slice portal, and CBHA dynamic arbitration."
        action={
          <div className="flex items-center gap-2">
            <Button
              variant={testbedStatus?.autoArbitration ? 'primary' : 'secondary'}
              size="sm"
              onClick={handleToggleArbitration}
            >
              {testbedStatus?.autoArbitration ? 'Auto-Arbitration: ON' : 'Auto-Arbitration: OFF'}
            </Button>
            <Button
              variant={recordingActive ? 'danger' : 'secondary'}
              size="sm"
              onClick={handleToggleExperiment}
            >
              {recordingActive ? 'Stop Recording' : 'Start Recording'}
            </Button>
          </div>
        }
      />

      {/* Testbed Status & Gateway Link Bar */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardBody className="p-4">
            <div className="text-xs text-text-subtle font-medium">Gateway Link State</div>
            <div className="flex items-center gap-2 mt-1">
              <span className={`w-2.5 h-2.5 rounded-full ${testbedStatus?.gatewayOk ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              <span className="text-base font-bold text-text">
                {testbedStatus?.gatewayOk ? 'Online (Real Shaping)' : 'Offline'}
              </span>
            </div>
            <div className="text-xs text-text-muted mt-1 font-mono">
              Port 8080 (Portal) • Port 9090 (Southbound)
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-4">
            <div className="text-xs text-text-subtle font-medium">Shared Link Capacity</div>
            <div className="text-base font-bold text-text mt-1">
              {formatBandwidth(capData?.admission?.offeredCapacityMbps ?? 950, bandwidthUnit)} offered
            </div>
            <div className="text-xs text-text-muted mt-1">
              Total: 1,000 {bandwidthUnit} (1.00 Mbps) &mdash; 50 {bandwidthUnit} reserved
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-4">
            <div className="text-xs text-text-subtle font-medium">Connected Client Devices</div>
            <div className="text-base font-bold text-accent-cyan mt-1">
              {devices.length} {devices.length === 1 ? 'Device' : 'Devices'} active
            </div>
            <div className="text-xs text-text-muted mt-1">
              Bound across {new Set(devices.map((d) => d.sliceCode)).size} slices
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-4">
            <div className="text-xs text-text-subtle font-medium">Portal LAN / Hotspot IP</div>
            <div className="flex items-center gap-2 mt-1">
              <select
                value={selectedLanIp}
                onChange={(e) => setSelectedLanIp(e.target.value)}
                className="bg-surface-elevated border border-border rounded px-2 py-1 text-xs text-text font-mono flex-1"
              >
                {testbedStatus?.lanIps?.map((net: { ip: string; isHotspot: boolean; interface: string; virtual?: boolean }) => (
                  <option key={net.ip} value={net.ip}>
                    {net.ip} ({net.isHotspot ? 'Hotspot' : net.interface}
                    {net.virtual ? ' — virtual, phones cannot reach it' : ''})
                  </option>
                ))}
                {(!testbedStatus?.lanIps || testbedStatus.lanIps.length === 0) && (
                  <option value="127.0.0.1">127.0.0.1 (Localhost)</option>
                )}
              </select>
            </div>
            <div className="text-[11px] text-text-muted mt-1 truncate">
              http://{selectedLanIp}:8080/
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Main Grid: SVG Topology (Left) + Detail/QR Drawer (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Topology Map (2 cols) */}
        <Card className="lg:col-span-2 overflow-hidden flex flex-col">
          <CardHeader
            title="Real-Network Topology Map"
            subtitle="Live Windows 11 gateway shaper routing traffic across 7 independent slice queues."
            action={
              <Badge style={statusStyles.neutral}>
                {bandwidthUnit.toUpperCase()} mode
              </Badge>
            }
          />
          <CardBody className="p-2 flex-1 flex items-center justify-center bg-slate-950/40">
            <svg
              viewBox="0 0 900 520"
              className="w-full h-auto select-none max-h-[520px]"
            >
              <defs>
                <radialGradient id="gatewayAura" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
                </radialGradient>
                <linearGradient id="linkNormal" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.6" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0.8" />
                </linearGradient>
                <linearGradient id="linkDegraded" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.6" />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.9" />
                </linearGradient>
              </defs>

              {/* Central Gateway Aura */}
              <circle cx="450" cy="260" r="110" fill="url(#gatewayAura)" />

              {/* Links from Center to Slices */}
              {topologyNodes.map((node) => {
                const liveSlice = telemetry?.snapshot?.slices?.find(
                  (s: { sliceId?: string; code?: string; allocatedMbps?: number; usedMbps?: number }) =>
                    s.sliceId === node.slice.id || s.code === node.slice.code
                );
                const isDegraded = liveSlice ? (liveSlice.allocatedMbps ?? 0) < node.slice.baselineAllocatedMbps : false;
                const hasLoad = liveSlice ? (liveSlice.usedMbps ?? 0) > 0 : false;

                return (
                  <g key={`link-${node.slice.id}`}>
                    <line
                      x1="450"
                      y1="260"
                      x2={node.x}
                      y2={node.y}
                      stroke={isDegraded ? 'url(#linkDegraded)' : 'url(#linkNormal)'}
                      strokeWidth={hasLoad ? 3 : 1.5}
                      strokeDasharray={hasLoad ? '6 4' : 'none'}
                      strokeOpacity={hasLoad ? 0.9 : 0.4}
                    />
                    {hasLoad && (
                      <circle r="3.5" fill={isDegraded ? '#f59e0b' : '#10b981'}>
                        <animateMotion
                          path={`M 450,260 L ${node.x},${node.y}`}
                          dur={`${Math.max(0.6, 2.5 - ((liveSlice?.usedMbps ?? 10) / 100))}s`}
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}
                  </g>
                );
              })}

              {/* Central Laptop Gateway Node */}
              <g transform="translate(450, 260)" className="cursor-default">
                <rect
                  x="-75"
                  y="-42"
                  width="150"
                  height="84"
                  rx="14"
                  fill="#0f172a"
                  stroke="#06b6d4"
                  strokeWidth="2"
                  className="filter drop-shadow-[0_0_12px_rgba(6,182,212,0.3)]"
                />
                <text
                  x="0"
                  y="-16"
                  textAnchor="middle"
                  fill="#e2e8f0"
                  fontSize="12"
                  fontWeight="bold"
                >
                  Windows 11 Gateway
                </text>
                <text
                  x="0"
                  y="2"
                  textAnchor="middle"
                  fill="#06b6d4"
                  fontSize="10"
                  fontWeight="600"
                  fontFamily="monospace"
                >
                  950 {bandwidthUnit} Offered
                </text>
                <text
                  x="0"
                  y="18"
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="9"
                >
                  Token-Bucket Shaper
                </text>
                <text
                  x="0"
                  y="30"
                  textAnchor="middle"
                  fill="#64748b"
                  fontSize="8"
                >
                  {devices.length} connected device(s)
                </text>
              </g>

              {/* 7 Slice Nodes */}
              {topologyNodes.map((node) => {
                const isSelected = selectedSlice?.id === node.slice.id;
                const liveSlice = telemetry?.snapshot?.slices?.find(
                  (s: { sliceId?: string; code?: string; allocatedMbps?: number; usedMbps?: number }) =>
                    s.sliceId === node.slice.id || s.code === node.slice.code
                );
                const isDegraded = liveSlice ? (liveSlice.allocatedMbps ?? 0) < node.slice.baselineAllocatedMbps : false;
                const isClinic = node.slice.code.includes('telemetry');
                const sliceDevices = devices.filter((d) => d.sliceCode === node.slice.code).length;

                let strokeColor = '#334155';
                let fillColor = '#1e293b';

                if (isSelected) {
                  strokeColor = '#3b82f6';
                  fillColor = '#1e3a8a';
                } else if (isDegraded) {
                  strokeColor = '#f59e0b';
                  fillColor = '#451a03';
                } else if (isClinic) {
                  strokeColor = '#10b981';
                  fillColor = '#064e3b';
                }

                return (
                  <g
                    key={node.slice.id}
                    transform={`translate(${node.x}, ${node.y})`}
                    onClick={() => setSelectedSlice(node.slice)}
                    className="cursor-pointer transition-transform hover:scale-105"
                  >
                    <rect
                      x="-65"
                      y="-34"
                      width="130"
                      height="68"
                      rx="10"
                      fill={fillColor}
                      stroke={strokeColor}
                      strokeWidth={isSelected ? '2.5' : '1.5'}
                      className="filter drop-shadow-md"
                    />

                    {/* Join Code Pill */}
                    <rect
                      x="18"
                      y="-30"
                      width="42"
                      height="15"
                      rx="4"
                      fill="#0f172a"
                      stroke="#475569"
                      strokeWidth="1"
                    />
                    <text
                      x="39"
                      y="-19"
                      textAnchor="middle"
                      fill="#38bdf8"
                      fontSize="8"
                      fontWeight="bold"
                      fontFamily="monospace"
                    >
                      {node.joinCode}
                    </text>

                    {/* Slice Name */}
                    <text
                      x="-55"
                      y="-16"
                      textAnchor="start"
                      fill="#f8fafc"
                      fontSize="10"
                      fontWeight="bold"
                    >
                      {node.slice.name.split(' ')[0]}
                    </text>

                    {/* Profile & Devices */}
                    <text
                      x="-55"
                      y="-2"
                      textAnchor="start"
                      fill="#94a3b8"
                      fontSize="8"
                    >
                      {node.slice.profile} • {sliceDevices} dev
                    </text>

                    {/* Limit / Carried Rate */}
                    <text
                      x="-55"
                      y="14"
                      textAnchor="start"
                      fill={isDegraded ? '#fbbf24' : '#10b981'}
                      fontSize="10"
                      fontWeight="bold"
                      fontFamily="monospace"
                    >
                      {liveSlice ? `${Math.round(liveSlice.allocatedMbps ?? 0)}` : node.slice.baselineAllocatedMbps} {bandwidthUnit}
                    </text>

                    {/* Degradation / Protection badge */}
                    {isDegraded && (
                      <text
                        x="-55"
                        y="26"
                        textAnchor="start"
                        fill="#f87171"
                        fontSize="8"
                        fontWeight="bold"
                      >
                        DEGRADED (−{Math.round(((node.slice.baselineAllocatedMbps - (liveSlice?.allocatedMbps ?? node.slice.baselineAllocatedMbps)) / node.slice.baselineAllocatedMbps) * 100)}%)
                      </text>
                    )}
                    {isClinic && (
                      <text
                        x="-55"
                        y="26"
                        textAnchor="start"
                        fill="#34d399"
                        fontSize="8"
                        fontWeight="bold"
                      >
                        PROTECTED (0% Ceiling)
                      </text>
                    )}
                    {!isDegraded && !isClinic && (
                      <text
                        x="-55"
                        y="26"
                        textAnchor="start"
                        fill="#64748b"
                        fontSize="8"
                      >
                        Used: {liveSlice ? Math.round(liveSlice.usedMbps ?? 0) : 0} {bandwidthUnit}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </CardBody>
        </Card>

        {/* Selected Slice Details & QR Code Drawer (1 col) */}
        <Card className="flex flex-col">
          <CardHeader
            title={selectedSlice ? selectedSlice.name : 'Slice Connection & Controls'}
            subtitle={selectedSlice ? `Join Code: ${selectedSlice.tags.find((t) => t.startsWith('join:'))?.slice(5) || 'N/A'}` : 'Select a slice in the topology map to view QR code'}
          />
          <CardBody className="p-4 space-y-4 flex-1">
            {selectedSlice ? (
              <>
                {/* QR Code Container */}
                <div className="flex flex-col items-center justify-center p-4 bg-white rounded-xl shadow-inner border border-slate-300">
                  {qrCodeUrl ? (
                    <img src={qrCodeUrl} alt="Join QR Code" className="w-44 h-44" />
                  ) : (
                    <div className="w-44 h-44 flex items-center justify-center text-slate-400 text-xs">
                      Generating QR...
                    </div>
                  )}
                  <div className="text-center mt-2">
                    <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider block">
                      Scan with Phone Camera
                    </span>
                    <span className="text-xs font-mono text-slate-800 break-all font-semibold">
                      http://{selectedLanIp}:8080/?code={selectedSlice.tags.find((t) => t.startsWith('join:'))?.slice(5) || ''}
                    </span>
                  </div>
                </div>

                {/* Slice Parameters */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2.5 rounded bg-surface-elevated border border-border">
                    <span className="text-text-muted block">Baseline Limit</span>
                    <span className="font-bold text-text">{selectedSlice.baselineAllocatedMbps} {bandwidthUnit}</span>
                  </div>
                  <div className="p-2.5 rounded bg-surface-elevated border border-border">
                    <span className="text-text-muted block">Floor Guarantee</span>
                    <span className="font-bold text-text">{selectedSlice.minGuaranteedMbps} {bandwidthUnit}</span>
                  </div>
                  <div className="p-2.5 rounded bg-surface-elevated border border-border">
                    <span className="text-text-muted block">Max Latency SLA</span>
                    <span className="font-bold text-text">&lt; {selectedSlice.slaTargets.maxLatencyMs} ms</span>
                  </div>
                  <div className="p-2.5 rounded bg-surface-elevated border border-border">
                    <span className="text-text-muted block">Max Loss SLA</span>
                    <span className="font-bold text-text">&lt; {selectedSlice.slaTargets.maxPacketLossPercent}%</span>
                  </div>
                </div>

                {/* Operator Remote Demand Push */}
                <div className="pt-2 border-t border-border space-y-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-text">Push Remote Demand:</span>
                    <span className="font-mono text-accent-cyan font-bold">{customDemand} {bandwidthUnit}</span>
                  </div>

                  <input
                    type="range"
                    min={0}
                    max={selectedSlice.baselineAllocatedMbps * 2}
                    value={customDemand}
                    onChange={(e) => setCustomDemand(parseInt(e.target.value, 10))}
                    className="w-full h-1.5 bg-surface-elevated rounded appearance-none cursor-pointer accent-accent-cyan"
                  />

                  <div className="grid grid-cols-3 gap-1.5 pt-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setCustomDemand(0);
                        handleApplyDemand(0);
                      }}
                    >
                      Idle (0)
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const val = Math.round(selectedSlice.baselineAllocatedMbps * 0.55);
                        setCustomDemand(val);
                        handleApplyDemand(val);
                      }}
                    >
                      Normal (55%)
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const val = selectedSlice.baselineAllocatedMbps * 2;
                        setCustomDemand(val);
                        handleApplyDemand(val);
                      }}
                    >
                      Flood (200%)
                    </Button>
                  </div>

                  <Button
                    size="sm"
                    variant="primary"
                    className="w-full mt-2"
                    disabled={applyingDemand}
                    onClick={() => handleApplyDemand(customDemand)}
                  >
                    {applyingDemand ? 'Applying...' : `Set Remote Demand to ${customDemand} ${bandwidthUnit}`}
                  </Button>
                </div>
              </>
            ) : (
              <div className="h-64 flex flex-col items-center justify-center text-center text-text-muted text-xs p-4">
                <Icons.network className="w-12 h-12 text-text-subtle mb-3 opacity-60" />
                <p>Click on any of the 7 slice nodes in the topology map to generate its QR code and manage remote demand.</p>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Scenario Runner & Experiments Bar */}
      <Card>
        <CardHeader
          title="Automated Scenario Runner (TC1–TC6)"
          subtitle="Drive coordinated load patterns to demonstrate CBHA arbitration and priority enforcement."
        />
        <CardBody className="p-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Button
              variant={runningScenario === 'TC1' ? 'primary' : 'secondary'}
              size="sm"
              className="flex flex-col items-center justify-center p-3 h-auto"
              onClick={() => handleRunScenario('TC1')}
            >
              <span className="font-bold text-xs">TC1: All Normal</span>
              <span className="text-[10px] text-text-muted mt-0.5">55% baseline</span>
            </Button>

            <Button
              variant={runningScenario === 'TC2' ? 'primary' : 'secondary'}
              size="sm"
              className="flex flex-col items-center justify-center p-3 h-auto"
              onClick={() => handleRunScenario('TC2')}
            >
              <span className="font-bold text-xs">TC2: Canteen Flood</span>
              <span className="text-[10px] text-text-muted mt-0.5">280 kbps shaper cap</span>
            </Button>

            <Button
              variant={runningScenario === 'TC3' ? 'primary' : 'secondary'}
              size="sm"
              className="flex flex-col items-center justify-center p-3 h-auto"
              onClick={() => handleRunScenario('TC3')}
            >
              <span className="font-bold text-xs">TC3: Lunch Rush</span>
              <span className="text-[10px] text-text-muted mt-0.5">CBHA Contention</span>
            </Button>

            <Button
              variant={runningScenario === 'TC4' ? 'primary' : 'secondary'}
              size="sm"
              className="flex flex-col items-center justify-center p-3 h-auto"
              onClick={() => handleRunScenario('TC4')}
            >
              <span className="font-bold text-xs">TC4: All Peak</span>
              <span className="text-[10px] text-text-muted mt-0.5">100% Demand</span>
            </Button>

            <Button
              variant={runningScenario === 'TC5' ? 'primary' : 'secondary'}
              size="sm"
              className="flex flex-col items-center justify-center p-3 h-auto"
              onClick={() => handleRunScenario('TC5')}
            >
              <span className="font-bold text-xs">TC5: Isolation Proof</span>
              <span className="text-[10px] text-text-muted mt-0.5">Clinic Zero Loss</span>
            </Button>

            <Button
              variant={runningScenario === 'TC6' ? 'primary' : 'secondary'}
              size="sm"
              className="flex flex-col items-center justify-center p-3 h-auto"
              onClick={() => handleRunScenario('TC1')}
            >
              <span className="font-bold text-xs">TC6: Step-down</span>
              <span className="text-[10px] text-text-muted mt-0.5">Restores baselines</span>
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* Bound Devices Table */}
      <Card>
        <CardHeader
          title={`Connected Testbed Devices (${devices.length})`}
          subtitle="Real client phones and laptops currently connected to slices through the portal."
        />
        <CardBody className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Device Nickname</Th>
                <Th>Source IP</Th>
                <Th>Slice Code</Th>
                <Th>Current Rate</Th>
                <Th>Mode</Th>
                <Th>Last Seen</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-6 text-text-muted text-xs">
                    No client devices bound yet. Scan any QR code above with your phone to connect!
                  </td>
                </tr>
              ) : (
                devices.map((dev) => (
                  <tr key={dev.deviceId}>
                    <Td className="font-semibold text-text">{dev.nickname}</Td>
                    <Td className="font-mono text-xs">{dev.sourceIp}</Td>
                    <Td>
                      <Badge style={statusStyles.neutral}>{dev.sliceCode}</Badge>
                    </Td>
                    <Td className="font-mono font-semibold text-accent-cyan">
                      {dev.activeRateKbps} {bandwidthUnit}
                    </Td>
                    <Td>
                      <span className="capitalize text-xs">{dev.mode}</span>
                    </Td>
                    <Td className="text-xs text-text-muted">
                      {Math.max(0, Math.round((Date.now() - dev.lastSeenMs) / 1000))}s ago
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await testbedApi.unbindDevice(dev.deviceId);
                          setDevices((prev) => prev.filter((d) => d.deviceId !== dev.deviceId));
                        }}
                      >
                        Unbind
                      </Button>
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
}
export default TestbedPage;
