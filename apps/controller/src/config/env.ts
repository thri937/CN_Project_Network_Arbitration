import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment configuration from root .env or package/cwd paths (except during test runs)
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.resolve(__dirname, '../../../../.env'), override: true });
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  dotenv.config();
}

/**
 * Environment configuration.
 *
 * Parsed and validated exactly once, at process start, and frozen. If configuration is
 * invalid the process exits immediately with a readable report rather than failing later
 * at an arbitrary call site — a misconfigured arbitration platform must not start.
 *
 * The three `*_DRIVER` / `TELEMETRY_PROVIDER` variables are the swap points described in
 * `docs/ARCHITECTURE.md`. Changing `TELEMETRY_PROVIDER=open5gs` re-wires the composition
 * root to an Open5GS adapter without touching a single line of domain or service code.
 */

const booleanish = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true' || v === '1' || v === 'yes'));

const intFromEnv = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const csv = (defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

export const DatastoreDriver = { FIRESTORE: 'firestore', MEMORY: 'memory' } as const;
export type DatastoreDriver = (typeof DatastoreDriver)[keyof typeof DatastoreDriver];

export const AuthDriver = { FIREBASE: 'firebase', DEV: 'dev' } as const;
export type AuthDriver = (typeof AuthDriver)[keyof typeof AuthDriver];

export const TelemetryProviderKind = {
  SYNTHETIC: 'synthetic',
  GATEWAY: 'gateway',
  OPEN5GS: 'open5gs',
  FREE5GC: 'free5gc',
  KUBERNETES: 'kubernetes',
} as const;
export type TelemetryProviderKind =
  (typeof TelemetryProviderKind)[keyof typeof TelemetryProviderKind];

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(4000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  API_PREFIX: z.string().default('/api/v1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanish(true),

  /* ---- CORS -------------------------------------------------------- */
  CORS_ORIGINS: csv('http://localhost:5173,http://localhost:4173'),

  /* ---- Adapter selection (the hexagonal swap points) --------------- */
  DATASTORE_DRIVER: z.nativeEnum(DatastoreDriver).default(DatastoreDriver.MEMORY),
  AUTH_DRIVER: z.nativeEnum(AuthDriver).default(AuthDriver.DEV),
  TELEMETRY_PROVIDER: z
    .nativeEnum(TelemetryProviderKind)
    .default(TelemetryProviderKind.SYNTHETIC),

  /* ---- Firebase ---------------------------------------------------- */
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  /** PEM private key. Newlines may be escaped as `\n` when set via a hosting dashboard. */
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  /** Alternative to the three vars above: path to a service-account JSON file. */
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),

  /* ---- Session JWT ------------------------------------------------- */
  /**
   * Backend-issued session token. Firebase ID tokens are exchanged for this once at login
   * so that the hot path (a telemetry poll every 2 s) does not hit Firebase token
   * verification, and so that role claims are resolved from our own datastore.
   */
  JWT_SECRET: z.string().min(32).default('dev-only-insecure-secret-change-me-in-production!!'),
  JWT_ISSUER: z.string().default('sentinel-arbitration'),
  JWT_AUDIENCE: z.string().default('sentinel-dashboard'),
  JWT_TTL_SECONDS: intFromEnv(3600, 60, 86_400),
  REFRESH_TTL_SECONDS: intFromEnv(60 * 60 * 24 * 14, 3600, 60 * 60 * 24 * 90),

  /* ---- Local persisted datastore (memory driver) ------------------- */
  MEMORY_STORE_DIR: z
    .string()
    .default(() => {
      const backendData = path.resolve(__dirname, '../../.data');
      return fs.existsSync(backendData) ? backendData : path.resolve(process.cwd(), '.data');
    })
    .transform((val) => {
      if (!path.isAbsolute(val)) {
        const inBackend = path.resolve(__dirname, '../../', val);
        if (fs.existsSync(inBackend)) {
          return inBackend;
        }
        return path.resolve(process.cwd(), val);
      }
      return val;
    }),
  MEMORY_STORE_PERSIST: booleanish(true),
  /** Debounce for flushing the in-memory store to disk. */
  MEMORY_STORE_FLUSH_MS: intFromEnv(1500, 100, 60_000),

  /* ---- Network model ----------------------------------------------- */
  BANDWIDTH_UNIT: z.string().default('kbps'),
  GATEWAY_URL: z.string().default('http://127.0.0.1:9090'),
  GATEWAY_TOKEN: z.string().default('change-me-long-random-gateway-token-sec-2026'),
  /** Total transport capacity of the modelled enterprise core, in Mbps. */
  NETWORK_TOTAL_CAPACITY_MBPS: z.coerce.number().positive().default(10_000),
  /** Capacity reserved for signalling/OAM and never offered to slices. */
  NETWORK_RESERVED_CAPACITY_MBPS: z.coerce.number().nonnegative().default(500),

  /* ---- Background jobs --------------------------------------------- */
  ENABLE_JOBS: booleanish(true),
  TELEMETRY_TICK_MS: intFromEnv(2000, 250, 60_000),
  CAPACITY_TICK_MS: intFromEnv(2000, 250, 60_000),
  CONTENTION_SCAN_MS: intFromEnv(2000, 250, 60_000),
  RECOVERY_SCAN_MS: intFromEnv(5000, 1000, 300_000),
  RETENTION_SWEEP_MS: intFromEnv(15 * 60_000, 60_000, 24 * 60 * 60_000),
  /** Automatically run arbitration when contention is confirmed. */
  AUTO_ARBITRATION: booleanish(true),

  /* ---- Telemetry persistence --------------------------------------- */
  /** Persist every telemetry sample (expensive) or only rolled-up snapshots. */
  TELEMETRY_PERSIST: booleanish(true),
  /** Write one telemetry document per N ticks to bound Firestore write cost. */
  TELEMETRY_PERSIST_EVERY_N_TICKS: intFromEnv(5, 1, 1000),

  /* ---- HTTP hardening ---------------------------------------------- */
  RATE_LIMIT_WINDOW_MS: intFromEnv(60_000, 1000, 60 * 60_000),
  RATE_LIMIT_MAX: intFromEnv(600, 10, 100_000),
  AUTH_RATE_LIMIT_MAX: intFromEnv(20, 3, 1000),
  BODY_LIMIT: z.string().default('256kb'),
  TRUST_PROXY: booleanish(true),

  /* ---- Realtime ---------------------------------------------------- */
  ENABLE_SOCKET_IO: booleanish(true),

  /* ---- Docs -------------------------------------------------------- */
  SWAGGER_ENABLED: booleanish(true),
  SWAGGER_PATH: z.string().default('/api/docs'),

  /* ---- Bootstrap --------------------------------------------------- */
  /**
   * The first user matching this email is promoted to ADMIN on first login. Everything
   * after that is managed through the User Management screen. Without this there is no
   * way to obtain the first admin in a fresh deployment.
   */
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
});

export type EnvConfig = Readonly<z.infer<typeof schema>> & {
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly isDevelopment: boolean;
};

function loadEnv(): EnvConfig {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Intentionally console, not the logger: the logger itself depends on this config.
    console.error(`\n[config] Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }

  const value = parsed.data;

  // Cross-field invariants that Zod cannot express field-by-field.
  const problems: string[] = [];

  if (value.NODE_ENV === 'production') {
    if (value.JWT_SECRET.startsWith('dev-only-insecure')) {
      problems.push('JWT_SECRET must be overridden in production');
    }
  }

  if (value.NETWORK_RESERVED_CAPACITY_MBPS >= value.NETWORK_TOTAL_CAPACITY_MBPS) {
    problems.push('NETWORK_RESERVED_CAPACITY_MBPS must be less than NETWORK_TOTAL_CAPACITY_MBPS');
  }

  if (problems.length > 0) {
    console.error(`\n[config] Invalid environment configuration:\n${problems.map((p) => `  • ${p}`).join('\n')}\n`);
    process.exit(1);
  }

  return Object.freeze({
    ...value,
    // Hosting dashboards store multi-line PEM keys with literal backslash-n.
    FIREBASE_PRIVATE_KEY: value.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    isProduction: value.NODE_ENV === 'production',
    isTest: value.NODE_ENV === 'test',
    isDevelopment: value.NODE_ENV === 'development',
  });
}

export const env: EnvConfig = loadEnv();

/** Offered (allocatable) capacity — total minus the reserved signalling/OAM slice. */
export const OFFERED_CAPACITY_MBPS =
  env.NETWORK_TOTAL_CAPACITY_MBPS - env.NETWORK_RESERVED_CAPACITY_MBPS;
