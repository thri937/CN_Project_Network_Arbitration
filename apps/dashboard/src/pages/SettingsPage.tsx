import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/auth/AuthProvider';
import { useRealtime } from '@/realtime/RealtimeProvider';
import { useTheme } from '@/lib/theme';
import { ApiError } from '@/api/client';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  LoadingState,
  PageHeader,
  Table,
  Td,
  Th,
  Tooltip,
} from '@/components/ui';
import { formatBandwidth, formatDuration, humanise, statusStyles } from '@/lib/format';

/**
 * Settings and system status.
 *
 * The maintenance-mode switch is the most consequential control in the product: it decides
 * whether the platform acts on contention at all. It is therefore presented with its
 * consequence spelled out, not as an unlabelled toggle.
 *
 * The system panel below exists because during an incident the first question is invariably
 * "is this deployment even wired the way we think it is?" — so the active adapters, job
 * statistics and control-loop state are all on one screen.
 */
export function SettingsPage(): JSX.Element {
  const { isAdmin } = useAuth();
  const { connected, framesReceived } = useRealtime();
  const { preference, setPreference } = useTheme();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: queryKeys.settings.current(),
    queryFn: settingsApi.get,
  });

  const { data: system } = useQuery({
    queryKey: queryKeys.settings.system(),
    queryFn: settingsApi.system,
    refetchInterval: 10_000,
  });

  const update = useMutation({
    mutationFn: (body: Parameters<typeof settingsApi.update>[0]) => settingsApi.update(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.all() });
    },
  });

  if (isLoading || !settings) return <LoadingState label="Loading settings" />;

  const arbitrationActive = settings.autoArbitrationEnabled && !settings.maintenanceMode;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description={settings.organisationName} />

      {update.error instanceof ApiError && (
        <div className="rounded-lg border border-critical/30 bg-critical/10 px-4 py-3">
          <p className="text-xs text-critical">{update.error.message}</p>
        </div>
      )}

      {/* ---- Control loop ---- */}
      <Card className={arbitrationActive ? undefined : 'border-warning/40'}>
        <CardHeader
          title="Automatic arbitration"
          subtitle="Whether the platform acts on contention without human involvement"
          action={
            <Badge style={arbitrationActive ? statusStyles.healthy : statusStyles.warning} dot pulse={!arbitrationActive}>
              {arbitrationActive ? 'Active' : 'Suspended'}
            </Badge>
          }
        />
        <CardBody className="space-y-4">
          <p className="text-xs leading-relaxed text-content-muted">
            When active, a confirmed contention triggers arbitration automatically and slices are
            degraded within seconds. When suspended, contention is still detected, measured and
            recorded — and arbitration can still be simulated or triggered by hand — but nothing is
            applied to the network.
          </p>

          {isAdmin ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant={settings.autoArbitrationEnabled ? 'secondary' : 'primary'}
                size="sm"
                loading={update.isPending}
                onClick={() =>
                  update.mutate({ autoArbitrationEnabled: !settings.autoArbitrationEnabled })
                }
              >
                {settings.autoArbitrationEnabled ? 'Disable automatic arbitration' : 'Enable automatic arbitration'}
              </Button>

              <Button
                variant={settings.maintenanceMode ? 'primary' : 'secondary'}
                size="sm"
                loading={update.isPending}
                onClick={() => update.mutate({ maintenanceMode: !settings.maintenanceMode })}
              >
                {settings.maintenanceMode ? 'End maintenance window' : 'Start maintenance window'}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-content-subtle">
              Only administrators can change the control-loop configuration.
            </p>
          )}

          {settings.maintenanceMode && settings.maintenanceReason && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
              <p className="text-xs text-warning">{settings.maintenanceReason}</p>
            </div>
          )}
        </CardBody>
      </Card>

      {/* ---- Appearance ---- */}
      <Card>
        <CardHeader title="Appearance" subtitle="Stored in this browser only" />
        <CardBody>
          <div className="flex gap-2">
            {(['dark', 'light', 'system'] as const).map((option) => (
              <button
                key={option}
                onClick={() => setPreference(option)}
                className={
                  preference === option
                    ? 'rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white'
                    : 'rounded-lg border border-edge-strong px-3 py-1.5 text-xs text-content-muted transition-colors hover:bg-surface-sunken hover:text-content'
                }
              >
                {humanise(option)}
              </button>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-content-muted">
            Dark is the default: this display is frequently wall-mounted and watched for hours.
            &ldquo;System&rdquo; follows the operating system preference and updates live.
          </p>
        </CardBody>
      </Card>

      {/* ---- System ---- */}
      {system && (
        <>
          <Card>
            <CardHeader
              title="Deployment wiring"
              subtitle="Which adapters this process is actually running"
            />
            <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Datastore" value={system.adapters.datastore} />
              <Field label="Identity provider" value={system.adapters.auth} />
              <Tooltip
                content={
                  <>
                    The telemetry provider is the only seam between this platform and the network.
                    Swapping it to <code>open5gs</code>, <code>free5gc</code> or{' '}
                    <code>kubernetes</code> is a single environment variable — no other code
                    changes.
                  </>
                }
              >
                <div className="w-full">
                  <Field label="Telemetry provider" value={system.adapters.telemetry} />
                </div>
              </Tooltip>
              <Field
                label="Enforcement"
                value={system.adapters.telemetryCapabilities.enforcement ? 'Yes' : 'Read-only'}
              />

              <Field
                label="Total capacity"
                value={formatBandwidth(system.network.totalCapacityMbps)}
              />
              <Field
                label="Reserved"
                value={formatBandwidth(system.network.reservedCapacityMbps)}
              />
              <Field
                label="Offered"
                value={formatBandwidth(system.network.offeredCapacityMbps)}
              />
              <Field label="Environment" value={`${system.environment} · v${system.version}`} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Control loop" />
            <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <Field
                label="Telemetry tick"
                value={`${system.controlLoop.telemetryTickMs} ms`}
              />
              <Field
                label="Snapshot age"
                value={
                  system.controlLoop.snapshotAgeMs === null
                    ? 'no snapshot'
                    : `${system.controlLoop.snapshotAgeMs} ms`
                }
              />
              <div>
                <div className="label">Telemetry health</div>
                <div className="mt-1.5">
                  <Badge
                    style={
                      system.controlLoop.telemetryHealth.status === 'up'
                        ? statusStyles.healthy
                        : system.controlLoop.telemetryHealth.status === 'down'
                          ? statusStyles.critical
                          : statusStyles.warning
                    }
                    dot
                  >
                    {system.controlLoop.telemetryHealth.status}
                  </Badge>
                </div>
              </div>
              <div>
                <div className="label">Realtime</div>
                <div className="mt-1.5 flex items-center gap-2">
                  <Badge style={connected ? statusStyles.healthy : statusStyles.warning} dot>
                    {connected ? 'Connected' : 'Polling'}
                  </Badge>
                  {connected && (
                    <span className="text-[11px] text-content-subtle tabular">
                      {framesReceived} frames
                    </span>
                  )}
                </div>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Background jobs"
              subtitle="Self-scheduling: each run is queued only after the previous one completes, so a slow tick can never overlap"
            />
            <Table>
              <thead>
                <tr>
                  <Th>Job</Th>
                  <Th align="right">Interval</Th>
                  <Th align="right">Runs</Th>
                  <Th align="right">Failures</Th>
                  <Th align="right">Overruns</Th>
                  <Th align="right">Last duration</Th>
                  <Th>Last error</Th>
                </tr>
              </thead>
              <tbody>
                {system.jobs.map((job) => (
                  <tr key={job.name}>
                    <Td className="font-medium">{job.name}</Td>
                    <Td align="right" className="text-content-muted">
                      {formatDuration(job.intervalMs / 1000)}
                    </Td>
                    <Td align="right">{job.runs}</Td>
                    <Td align="right" className={job.failures > 0 ? 'text-critical' : ''}>
                      {job.failures}
                    </Td>
                    <Td align="right" className={job.overruns > 0 ? 'text-warning' : ''}>
                      {job.overruns}
                    </Td>
                    <Td align="right" className="text-content-muted">
                      {job.lastDurationMs === null ? '—' : `${job.lastDurationMs} ms`}
                    </Td>
                    <Td className="max-w-xs truncate text-critical">{job.lastError ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="mt-1 font-mono text-sm text-content">{value}</div>
    </div>
  );
}
