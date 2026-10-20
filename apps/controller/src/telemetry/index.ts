import { TelemetryProviderKind, env } from '@/config/env';
import type { INetworkTelemetryPort } from '@/interfaces/telemetry.port';
import type { SlaTargets } from '@/models/slice.model';
import { createLogger } from '@/utils/logger';
import { SyntheticTelemetryAdapter } from './synthetic/synthetic.telemetry.adapter';
import {
  FREE5GC_DEFAULT_QUERIES,
  OPEN5GS_DEFAULT_QUERIES,
  PrometheusTelemetryAdapter,
  type PrometheusTelemetryConfig,
} from './adapters/prometheus.telemetry.adapter';
import { KubernetesTelemetryAdapter } from './adapters/kubernetes.telemetry.adapter';
import { GatewayTelemetryAdapter } from './adapters/gateway.telemetry.adapter';

const log = createLogger('telemetry-factory');

/**
 * Telemetry provider factory — the hexagonal swap point for the network.
 *
 * The ONLY function that inspects `TELEMETRY_PROVIDER`. Everything above receives an
 * `INetworkTelemetryPort` and cannot tell whether it is talking to a modelled network, a
 * live Open5GS core, or a Kubernetes cluster.
 *
 * To move from the modelled network to a real one:
 *
 *     TELEMETRY_PROVIDER=open5gs
 *     TELEMETRY_PROMETHEUS_URL=http://prometheus.5gc.svc:9090
 *     TELEMETRY_CONTROL_PLANE_URL=http://pcf.5gc.svc:8080     # optional, for enforcement
 *
 * No other file changes.
 */

/**
 * Providers that score health against per-slice SLA targets need those targets pushed to
 * them. Expressed as a capability check rather than an `instanceof` chain so a new adapter
 * participates without editing the telemetry service.
 */
export interface SlaAwareProvider {
  registerSlaTargets(sliceId: string, targets: SlaTargets): void;
}

export function isSlaAware(provider: INetworkTelemetryPort): provider is INetworkTelemetryPort &
  SlaAwareProvider {
  return typeof (provider as Partial<SlaAwareProvider>).registerSlaTargets === 'function';
}

export function isSyntheticProvider(
  provider: INetworkTelemetryPort,
): provider is SyntheticTelemetryAdapter {
  return provider instanceof SyntheticTelemetryAdapter;
}

export interface TelemetryFactoryOptions {
  kind?: TelemetryProviderKind;
  /** Overrides for the Prometheus-backed adapters; used by integration tests. */
  prometheus?: Partial<PrometheusTelemetryConfig>;
}

export async function createTelemetryProvider(
  options: TelemetryFactoryOptions = {},
): Promise<INetworkTelemetryPort> {
  const kind = options.kind ?? env.TELEMETRY_PROVIDER;

  switch (kind) {
    case TelemetryProviderKind.SYNTHETIC: {
      const provider = new SyntheticTelemetryAdapter();
      log.info({ provider: kind }, 'telemetry provider ready');
      return provider;
    }

    case TelemetryProviderKind.GATEWAY: {
      const provider = new GatewayTelemetryAdapter({
        baseUrl: process.env.GATEWAY_URL || 'http://127.0.0.1:9090',
        token: process.env.GATEWAY_TOKEN || 'change-me-long-random',
        timeoutMs: Number(process.env.TELEMETRY_TIMEOUT_MS ?? 4000),
      });
      try {
        await provider.ping();
      } catch (err: any) {
        log.warn({ error: err.message }, 'gateway ping failed during startup (gateway may still be booting)');
      }
      log.info({ provider: kind }, 'telemetry provider ready');
      return provider;
    }

    case TelemetryProviderKind.OPEN5GS:
    case TelemetryProviderKind.FREE5GC: {
      const provider = new PrometheusTelemetryAdapter(
        buildPrometheusConfig(kind, options.prometheus),
      );
      // Fail fast: an unreachable metrics backend must surface at boot, not on the first
      // contention event when the platform most needs to be trusted.
      await provider.ping();
      log.info({ provider: kind }, 'telemetry provider ready');
      return provider;
    }

    case TelemetryProviderKind.KUBERNETES: {
      const provider = new KubernetesTelemetryAdapter({
        metricsUrl: requireEnv('TELEMETRY_PROMETHEUS_URL'),
        namespace: process.env.TELEMETRY_K8S_NAMESPACE ?? 'default',
        timeoutMs: Number(process.env.TELEMETRY_TIMEOUT_MS ?? 5000),
        ...(process.env.TELEMETRY_PROMETHEUS_TOKEN
          ? { token: process.env.TELEMETRY_PROMETHEUS_TOKEN }
          : {}),
      });
      await provider.ping();
      log.info({ provider: kind }, 'telemetry provider ready');
      return provider;
    }

    default:
      return assertUnreachable(kind);
  }
}

function buildPrometheusConfig(
  kind: TelemetryProviderKind,
  overrides: Partial<PrometheusTelemetryConfig> | undefined,
): PrometheusTelemetryConfig {
  const controlPlaneUrl = process.env.TELEMETRY_CONTROL_PLANE_URL;

  return {
    baseUrl: overrides?.baseUrl ?? requireEnv('TELEMETRY_PROMETHEUS_URL'),
    queries:
      overrides?.queries ??
      (kind === TelemetryProviderKind.FREE5GC
        ? FREE5GC_DEFAULT_QUERIES
        : OPEN5GS_DEFAULT_QUERIES),
    timeoutMs: overrides?.timeoutMs ?? Number(process.env.TELEMETRY_TIMEOUT_MS ?? 5000),
    label: overrides?.label ?? kind,
    ...(process.env.TELEMETRY_PROMETHEUS_TOKEN
      ? { token: process.env.TELEMETRY_PROMETHEUS_TOKEN }
      : {}),
    ...(overrides?.controlPlane
      ? { controlPlane: overrides.controlPlane }
      : controlPlaneUrl
        ? {
            controlPlane: {
              baseUrl: controlPlaneUrl,
              method: (process.env.TELEMETRY_CONTROL_PLANE_METHOD as 'POST' | 'PUT' | 'PATCH') ?? 'PATCH',
              pathTemplate:
                process.env.TELEMETRY_CONTROL_PLANE_PATH ?? '/policy/slices/{sst}/{sd}/ambr',
              timeoutMs: Number(process.env.TELEMETRY_CONTROL_PLANE_TIMEOUT_MS ?? 8000),
              ...(process.env.TELEMETRY_CONTROL_PLANE_TOKEN
                ? { token: process.env.TELEMETRY_CONTROL_PLANE_TOKEN }
                : {}),
            },
          }
        : {}),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set when TELEMETRY_PROVIDER is a live network provider. ` +
        `Set TELEMETRY_PROVIDER=synthetic to run against the modelled network instead.`,
    );
  }
  return value;
}

function assertUnreachable(kind: never): never {
  throw new Error(`Unsupported telemetry provider '${String(kind)}'`);
}

export { SyntheticTelemetryAdapter } from './synthetic/synthetic.telemetry.adapter';
export { GatewayTelemetryAdapter } from './adapters/gateway.telemetry.adapter';
export { PrometheusTelemetryAdapter } from './adapters/prometheus.telemetry.adapter';
export { KubernetesTelemetryAdapter } from './adapters/kubernetes.telemetry.adapter';
export { FaultKind } from './synthetic/trafficModel';
export { assessHealth } from './synthetic/health';
