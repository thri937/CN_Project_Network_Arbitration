import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { testbedApi, type GatewaySliceStats, type TestbedDevice } from '@/api/resources';
import { useAuth } from '@/auth/AuthProvider';
import { useSlicesWithDepartments } from '@/hooks/useLiveData';
import { Button, Card, CardBody, CardHeader, PageHeader, Table, Td, Th } from '@/components/ui';
import { formatBandwidth, formatLatency, formatPercent, formatRelative } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Department, Slice } from '@/types/api';

/** Display order: most critical department first. */
const ORDER = [
  'patient-telemetry',
  'factory-automation',
  'lab-instrumentation',
  'warehouse-operations',
  'cctv',
  'office-wi-fi',
  'canteen-signage',
];

const PROFILE_LABEL: Record<string, string> = { URLLC: 'URLLC', EMBB: 'eMBB', MMTC: 'mMTC', V2X: 'V2X' };

/** The dashboard's scenario buttons. They set the demand of every joined device. */
const SCENARIOS: { id: string; name: string; what: string }[] = [
  { id: 'IDLE', name: 'All idle', what: 'Every device stops sending.' },
  { id: 'TC1', name: 'TC1 Normal day', what: 'All slices at 55 % of baseline, about 814 kbps. No contention.' },
  { id: 'TC2', name: 'TC2 Canteen flood', what: 'Canteen at 200 %, others 55 %. The Canteen’s own limit holds it; nothing is cut.' },
  { id: 'TC3', name: 'TC3 Lunch-hour rush', what: 'Canteen 200 %, Office and CCTV 100 %, Warehouse 80 %. About 1,309 kbps: the engine cuts the cheapest slices.' },
  { id: 'TC4', name: 'TC4 Everyone at peak', what: 'All slices at 100 %, 1,480 kbps. Even the deepest allowed cuts are not enough: a PARTIAL decision.' },
  { id: 'TC5', name: 'TC5 Back to normal', what: 'All slices at 55 %. Contention closes; cut slices return after their recovery window.' },
];

const DEMAND_PRESETS: { label: string; fraction: number }[] = [
  { label: 'Idle', fraction: 0 },
  { label: 'Normal 55 %', fraction: 0.55 },
  { label: 'Peak 100 %', fraction: 1 },
  { label: 'Flood 200 %', fraction: 2 },
];

function joinCodeOf(slice: Slice): string {
  return slice.tags.find((t) => t.startsWith('join:'))?.slice(5) ?? '—';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function TestbedPage(): JSX.Element {
  const { hasRole } = useAuth();
  const canManage = hasRole('MANAGER');
  const queryClient = useQueryClient();

  const status = useQuery({ queryKey: ['testbed', 'status'], queryFn: testbedApi.status, refetchInterval: 2000 });
  const devices = useQuery({ queryKey: ['testbed', 'devices'], queryFn: testbedApi.devices, refetchInterval: 2000 });
  const { slices, departmentById } = useSlicesWithDepartments();

  const [selectedCode, setSelectedCode] = useState<string>('patient-telemetry');
  const [address, setAddress] = useState<string>('');
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  const s = status.data;
  const statsByCode = useMemo(() => new Map((s?.stats ?? []).map((x) => [x.code, x])), [s?.stats]);
  const devicesBySlice = useMemo(() => {
    const map = new Map<string, TestbedDevice[]>();
    for (const d of devices.data ?? []) map.set(d.sliceCode, [...(map.get(d.sliceCode) ?? []), d]);
    return map;
  }, [devices.data]);

  const rows = useMemo(
    () => [...slices].sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code)),
    [slices],
  );
  const selected = rows.find((r) => r.code === selectedCode) ?? rows[0];

  // Default join address: the first one phones can reach (hotspot, then Wi-Fi).
  useEffect(() => {
    if (address || !s?.lanIps?.length) return;
    setAddress((s.lanIps.find((n) => !n.virtual) ?? s.lanIps[0])!.ip);
  }, [s?.lanIps, address]);

  const portalPort = s?.portalPort ?? 8080;
  const joinUrl = selected ? `http://${address || 'localhost'}:${portalPort}/join?code=${joinCodeOf(selected)}` : '';

  const [qr, setQr] = useState('');
  useEffect(() => {
    if (!joinUrl) return;
    QRCode.toDataURL(joinUrl, { width: 200, margin: 1 })
      .then(setQr)
      .catch(() => setQr(''));
  }, [joinUrl]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['testbed'] });
  };
  const say = (text: string, error = false) => setNotice({ text, error });

  const scenario = useMutation({
    mutationFn: (id: string) => testbedApi.runScenario(id),
    onSuccess: (r) => say(`${r.label}: sent to every joined device.`),
    onError: (e) => say(errorText(e), true),
  });
  const arbitration = useMutation({
    mutationFn: (enabled: boolean) => testbedApi.setArbitration(enabled),
    onSuccess: (r) => {
      say(`Automatic arbitration is now ${r.enabled ? 'on' : 'off'}.`);
      refresh();
    },
    onError: (e) => say(errorText(e), true),
  });
  const demand = useMutation({
    mutationFn: ({ slice, kbps }: { slice: Slice; kbps: number }) => testbedApi.setSliceDemand(slice.id, kbps),
    onSuccess: (_r, v) => say(`${v.slice.name}: devices set to ${formatBandwidth(v.kbps)}.`),
    onError: (e) => say(errorText(e), true),
  });
  const rotate = useMutation({
    mutationFn: (slice: Slice) => testbedApi.rotateJoinCode(slice.id),
    onSuccess: (r) => {
      say(`New join code ${r.newJoinCode}. Devices already joined stay joined.`);
      void queryClient.invalidateQueries({ queryKey: ['slices'] });
    },
    onError: (e) => say(errorText(e), true),
  });
  const unbind = useMutation({
    mutationFn: (id: string) => testbedApi.unbindDevice(id),
    onSuccess: () => {
      say('Device removed from its slice.');
      refresh();
    },
    onError: (e) => say(errorText(e), true),
  });

  const download = async () => {
    try {
      const { blob, fileName } = await testbedApi.downloadRecording();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      say(errorText(e), true);
    }
  };

  const offered = s?.capacity?.offeredMbps ?? 950;
  const total = s?.capacity?.totalMbps ?? 1000;
  const carried = (s?.stats ?? []).reduce((t, x) => t + x.usedKbps, 0);
  const demanded = (s?.stats ?? []).reduce((t, x) => t + x.demandKbps, 0);
  const deviceCount = devices.data?.length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Slices and devices"
        description="The 1 Mbps link on this laptop, the seven department slices that share it, and the devices joined to them."
      />

      {notice && (
        <div
          className={cn(
            'flex items-start justify-between gap-4 rounded-lg border px-4 py-2.5 text-sm',
            notice.error ? 'border-critical/40 text-critical' : 'border-edge text-content',
          )}
          role="status"
        >
          <span>{notice.text}</span>
          <button className="text-content-subtle hover:text-content" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {/* Status ------------------------------------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatusBlock
          title="Gateway"
          value={s?.gatewayOk ? 'Running' : status.isLoading ? 'Checking…' : 'Not reachable'}
          tone={s?.gatewayOk ? 'ok' : 'bad'}
          detail={s?.gatewayOk ? `Department page on port ${portalPort}` : 'Start it with npm run dev'}
        />
        <StatusBlock
          title="Shared link"
          value={`${formatBandwidth(carried)} of ${formatBandwidth(offered)}`}
          detail={`Demand ${formatBandwidth(demanded)} · ${formatBandwidth(total)} link, ${formatBandwidth(total - offered)} reserved`}
          tone={demanded > offered * 1.02 ? 'warn' : 'ok'}
        />
        <StatusBlock
          title="Devices joined"
          value={String(deviceCount)}
          detail={`${new Set((devices.data ?? []).map((d) => d.sliceCode)).size} of 7 slices have a device`}
        />
        <div className="rounded-lg border border-edge bg-surface-raised p-4">
          <div className="text-xs text-content-muted">Automatic arbitration</div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <div className="text-lg font-semibold text-content">{s?.autoArbitration ? 'On' : 'Off'}</div>
            {canManage && s && (
              <Button size="sm" onClick={() => arbitration.mutate(!s.autoArbitration)} loading={arbitration.isPending}>
                Turn {s.autoArbitration ? 'off' : 'on'}
              </Button>
            )}
          </div>
          <div className="mt-1 text-xs text-content-subtle">Off is the "no arbitration" half of TC6.</div>
        </div>
      </div>

      <LinkBar carried={carried} demand={demanded} offered={offered} />

      {/* Slices + selected slice ---------------------------------------- */}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Slices"
            subtitle="Measured by the gateway every 2 seconds. Click a slice for its join code and QR code."
          />
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Department / slice</Th>
                  <Th>Code</Th>
                  <Th align="right">Devices</Th>
                  <Th align="right">Demand</Th>
                  <Th align="right">Limit</Th>
                  <Th align="right">Carried</Th>
                  <Th align="right">Latency p95</Th>
                  <Th align="right">Loss</Th>
                  <Th>State</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((slice) => (
                  <SliceRow
                    key={slice.id}
                    slice={slice}
                    department={departmentById.get(slice.departmentId)}
                    stats={statsByCode.get(slice.code)}
                    devices={devicesBySlice.get(slice.code)?.length ?? 0}
                    selected={slice.code === selected?.code}
                    onSelect={() => setSelectedCode(slice.code)}
                  />
                ))}
                {rows.length === 0 && (
                  <tr>
                    <Td colSpan={9} className="py-8 text-center text-content-muted">
                      No slices yet. Run <code>npm run seed</code>.
                    </Td>
                  </tr>
                )}
              </tbody>
            </Table>
          </div>
        </Card>

        <Card>
          <CardHeader title={selected ? selected.name : 'Slice'} subtitle={selected ? departmentById.get(selected.departmentId)?.name : undefined} />
          {selected && (
            <CardBody className="space-y-4">
              <div className="flex items-start gap-4">
                {qr ? (
                  <img src={qr} alt={`QR code for ${joinUrl}`} className="h-32 w-32 shrink-0 rounded border border-edge bg-white p-1" />
                ) : (
                  <div className="grid h-32 w-32 shrink-0 place-items-center rounded border border-edge text-xs text-content-subtle">
                    No QR
                  </div>
                )}
                <div className="min-w-0 space-y-1 text-sm">
                  <div>
                    Join code <span className="font-mono font-semibold">{joinCodeOf(selected)}</span>
                  </div>
                  <div className="break-all font-mono text-xs text-content-muted">{joinUrl}</div>
                  <div className="text-xs text-content-subtle">Scan with a phone on the same Wi-Fi or hotspot.</div>
                </div>
              </div>

              <label className="block text-xs text-content-muted">
                Address phones use
                <select
                  className="mt-1 block w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm text-content"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                >
                  {(s?.lanIps ?? []).map((n) => (
                    <option key={n.ip} value={n.ip}>
                      {n.ip} — {n.isHotspot ? 'hotspot' : n.interface}
                      {n.virtual ? ' (virtual adapter, phones cannot reach it)' : ''}
                    </option>
                  ))}
                  <option value="localhost">localhost (this laptop only)</option>
                </select>
              </label>

              {canManage && (
                <div>
                  <div className="text-xs text-content-muted">Set demand for this slice’s devices</div>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {DEMAND_PRESETS.map((p) => (
                      <Button
                        key={p.label}
                        size="sm"
                        variant="secondary"
                        disabled={demand.isPending}
                        onClick={() => demand.mutate({ slice: selected, kbps: Math.round(selected.baselineAllocatedMbps * p.fraction) })}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                  <div className="mt-1 text-xs text-content-subtle">
                    Baseline {formatBandwidth(selected.baselineAllocatedMbps)}. Only devices already joined to this slice follow.
                  </div>
                </div>
              )}

              {canManage && (
                <Button size="sm" variant="ghost" onClick={() => rotate.mutate(selected)} loading={rotate.isPending}>
                  New join code
                </Button>
              )}
            </CardBody>
          )}
        </Card>
      </div>

      {/* Scenarios ------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Test scenarios"
          subtitle="Each button sets the demand of every joined device. A slice with no device generates no traffic."
        />
        <CardBody>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {SCENARIOS.map((sc) => (
              <div key={sc.id} className="flex flex-col justify-between gap-2 rounded-lg border border-edge p-3">
                <div>
                  <div className="text-sm font-medium text-content">{sc.name}</div>
                  <div className="mt-0.5 text-xs text-content-muted">{sc.what}</div>
                </div>
                {canManage && (
                  <div>
                    <Button size="sm" variant="secondary" onClick={() => scenario.mutate(sc.id)} loading={scenario.isPending && scenario.variables === sc.id}>
                      Run
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-content-muted">
            <span className="font-medium text-content">TC6, the on/off comparison:</span> run TC3, turn automatic
            arbitration <em>off</em> and wait a minute, then turn it <em>on</em> and wait another minute. Wait about
            25 seconds after each switch before reading the numbers: the shared queue needs that long to fill or drain.
            Everything is recorded; download the CSV below.
          </p>
        </CardBody>
      </Card>

      {/* Devices ---------------------------------------------------------- */}
      <Card>
        <CardHeader title={`Devices (${deviceCount})`} subtitle="Phones, laptops and browser tabs joined to a slice. A device that is silent for 15 seconds is dropped." />
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Address</Th>
                <Th>Slice</Th>
                <Th align="right">Asking for</Th>
                <Th>Traffic</Th>
                <Th>Last seen</Th>
                {canManage && <Th align="right"> </Th>}
              </tr>
            </thead>
            <tbody>
              {(devices.data ?? []).map((d) => (
                <tr key={d.deviceId}>
                  <Td>{d.nickname}</Td>
                  <Td className="font-mono text-xs">{d.sourceIp}</Td>
                  <Td>{rows.find((r) => r.code === d.sliceCode)?.name ?? d.sliceCode}</Td>
                  <Td align="right" className="whitespace-nowrap">{formatBandwidth(d.activeRateKbps)}</Td>
                  <Td>{d.mode === 'internet' ? 'Through the ISP' : 'Local'}</Td>
                  <Td>{formatRelative(d.lastSeenMs)}</Td>
                  {canManage && (
                    <Td align="right" className="whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => unbind.mutate(d.deviceId)}>
                        Remove
                      </Button>
                    </Td>
                  )}
                </tr>
              ))}
              {deviceCount === 0 && (
                <tr>
                  <Td colSpan={7} className="py-6 text-center text-content-muted">
                    No devices yet. Open a slice’s join address on a phone, or in another browser tab.
                  </Td>
                </tr>
              )}
            </tbody>
          </Table>
        </div>
      </Card>

      {/* Recording -------------------------------------------------------- */}
      <Card>
        <CardHeader title="Recording" subtitle="Every 2-second gateway window of this session is saved, labelled with the last scenario run." />
        <CardBody className="flex flex-wrap items-center justify-between gap-3 text-sm">
          {s?.recording ? (
            <span className="text-content-muted">
              <span className="font-mono text-content">experiments/{s.recording.file}</span> · {s.recording.rowCount.toLocaleString('en-GB')} rows · label{' '}
              <span className="font-mono">{s.recording.label}</span>
            </span>
          ) : (
            <span className="text-content-muted">Not recording: the gateway adapter is not in use.</span>
          )}
          {s?.recording && s.recording.rowCount > 0 && (
            <Button size="sm" variant="secondary" onClick={() => void download()}>
              Download CSV
            </Button>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StatusBlock({ title, value, detail, tone }: { title: string; value: string; detail?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-raised p-4">
      <div className="text-xs text-content-muted">{title}</div>
      <div
        className={cn(
          'mt-1 text-lg font-semibold',
          tone === 'bad' ? 'text-critical' : tone === 'warn' ? 'text-warning' : 'text-content',
        )}
      >
        {value}
      </div>
      {detail && <div className="mt-1 text-xs text-content-subtle">{detail}</div>}
    </div>
  );
}

/** Carried traffic against the offered capacity, with total demand marked. */
function LinkBar({ carried, demand, offered }: { carried: number; demand: number; offered: number }) {
  const scale = Math.max(offered * 1.6, demand, 1);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  return (
    <div className="rounded-lg border border-edge bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-content-muted">
        <span>Link use</span>
        <span>
          carried <span className="text-content">{formatBandwidth(carried)}</span> · demand{' '}
          <span className="text-content">{formatBandwidth(demand)}</span> · capacity{' '}
          <span className="text-content">{formatBandwidth(offered)}</span>
        </span>
      </div>
      <div className="relative mt-2 h-3 rounded bg-surface-sunken">
        <div className="absolute inset-y-0 left-0 rounded bg-brand/70" style={{ width: pct(carried) }} />
        <div className="absolute inset-y-[-3px] w-0.5 bg-content" style={{ left: pct(offered) }} title="Capacity" />
        {demand > 0 && <div className="absolute inset-y-[-3px] w-0.5 bg-warning" style={{ left: pct(demand) }} title="Demand" />}
      </div>
      <div className="mt-1.5 text-xs text-content-subtle">
        Black line: the 950 kbps the slices share. Orange line: what the devices are asking for. Contention opens when demand
        stays above 102 % of capacity for 4 seconds.
      </div>
    </div>
  );
}

function SliceRow({
  slice,
  department,
  stats,
  devices,
  selected,
  onSelect,
}: {
  slice: Slice;
  department?: Department;
  stats?: GatewaySliceStats;
  devices: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const limit = stats?.limitKbps ?? slice.allocatedMbps;
  const cutPct = slice.baselineAllocatedMbps > 0 ? (1 - limit / slice.baselineAllocatedMbps) * 100 : 0;
  const exempt = department?.structurallyExempt ?? false;
  const latency = stats?.latencyP95Ms ?? null;
  const overLatency = latency !== null && latency > slice.slaTargets.maxLatencyMs;
  const overLoss = (stats?.lossPct ?? 0) > slice.slaTargets.maxPacketLossPercent;

  let state: string;
  let stateClass = 'text-content-muted';
  if (cutPct > 0.5) {
    state = `Cut ${cutPct.toFixed(0)} %`;
    stateClass = 'text-degraded';
  } else if (exempt) {
    state = 'Never cut';
  } else {
    state = `Up to ${formatPercent(department?.effectiveDegradationCeiling ?? null, 0)} cut`;
  }

  return (
    <tr
      onClick={onSelect}
      className={cn('cursor-pointer', selected ? 'bg-brand/10' : 'hover:bg-surface-sunken')}
      aria-selected={selected}
    >
      <Td>
        <div className="font-medium text-content">{department?.name ?? '—'}</div>
        <div className="text-xs text-content-muted">
          {slice.name} · {PROFILE_LABEL[slice.profile] ?? slice.profile}
        </div>
      </Td>
      <Td className="font-mono text-xs">{joinCodeOf(slice)}</Td>
      <Td align="right" className="whitespace-nowrap">{devices}</Td>
      <Td align="right" className="whitespace-nowrap">{formatBandwidth(stats?.demandKbps ?? null)}</Td>
      <Td align="right" className="whitespace-nowrap">
        <div>{formatBandwidth(limit)}</div>
        <div className="text-xs text-content-subtle">of {formatBandwidth(slice.baselineAllocatedMbps)}</div>
      </Td>
      <Td align="right" className="whitespace-nowrap">{formatBandwidth(stats?.usedKbps ?? null)}</Td>
      <Td align="right" className={cn('whitespace-nowrap', overLatency && 'text-critical')}>
        <div>{formatLatency(latency)}</div>
        <div className="text-xs text-content-subtle">target {formatLatency(slice.slaTargets.maxLatencyMs)}</div>
      </Td>
      <Td align="right" className={cn('whitespace-nowrap', overLoss && 'text-critical')}>
        {stats && stats.activeSessions + stats.activeDevices > 0 ? formatPercent(stats.lossPct, 1) : '—'}
      </Td>
      <Td className={cn('whitespace-nowrap', stateClass)}>{state}</Td>
    </tr>
  );
}
