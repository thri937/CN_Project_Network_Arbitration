import type http from 'node:http';
import { Router } from 'express';
import { createAuthProvider } from '@/auth';
import { env } from '@/config/env';
import { createBaseContainer, type BaseContainer, type ContainerOverrides } from '@/container';
import type { IAuthPort } from '@/interfaces/auth.port';
import type { IDatastore } from '@/interfaces/repository.port';
import type { INetworkTelemetryPort } from '@/interfaces/telemetry.port';
import { createTelemetryProvider, type TelemetryFactoryOptions } from '@/telemetry';
import { JobScheduler } from '@/jobs/scheduler';
import { RealtimeGateway } from '@/realtime/gateway';
import { buildOpenApiDocument } from '@/docs/openapi';
import swaggerUi from 'swagger-ui-express';
import { createDatastore, type DatastoreFactoryOptions } from '@/repositories';
import { DepartmentRepository } from '@/repositories/department.repository';
import { PolicyRepository } from '@/repositories/policy.repository';
import { ArbitrationRepository } from '@/repositories/arbitration.repository';
import { ContentionRepository } from '@/repositories/contention.repository';
import { SliceRepository } from '@/repositories/slice.repository';
import { TelemetryRepository } from '@/repositories/telemetry.repository';
import { UserRepository } from '@/repositories/user.repository';
import { AllocationService } from '@/services/allocation.service';
import { ArbitrationService } from '@/services/arbitration.service';
import { AuditService } from '@/services/audit.service';
import { AuthService } from '@/services/auth.service';
import { NotificationService } from '@/services/notification.service';
import { SettingsService } from '@/services/settings.service';
import { CapacityService } from '@/services/capacity.service';
import { ContentionService } from '@/services/contention.service';
import { DepartmentService } from '@/services/department.service';
import { PolicyService } from '@/services/policy.service';
import { SliceService } from '@/services/slice.service';
import { TelemetryService } from '@/services/telemetry.service';
import { TokenService } from '@/services/token.service';
import { UserService } from '@/services/user.service';
import { createAuthMiddleware, type AuthMiddleware } from '@/middleware/authenticate';
import {
  createArbitrationController,
  type ArbitrationController,
} from '@/controllers/arbitration.controller';
import { createAuditController, type AuditController } from '@/controllers/audit.controller';
import { createAuthController, type AuthController } from '@/controllers/auth.controller';
import { createCapacityController, type CapacityController } from '@/controllers/capacity.controller';
import {
  createContentionController,
  type ContentionController,
} from '@/controllers/contention.controller';
import {
  createDepartmentController,
  type DepartmentController,
} from '@/controllers/department.controller';
import { createPolicyController, type PolicyController } from '@/controllers/policy.controller';
import { createSettingsController, type SettingsController } from '@/controllers/settings.controller';
import { createSliceController, type SliceController } from '@/controllers/slice.controller';
import {
  createTelemetryController,
  type TelemetryController,
} from '@/controllers/telemetry.controller';
import { createUserController, type UserController } from '@/controllers/user.controller';
import { createTestbedController } from '@/controllers/testbed.controller';
import { createLogger } from '@/utils/logger';

const log = createLogger('bootstrap');

/**
 * Container assembly.
 *
 * `container.ts` defines the *shape*; this file performs the *wiring* — reading the
 * environment, choosing adapters, and constructing the object graph in dependency order.
 * Splitting the two keeps `container.ts` importable from tests without dragging in
 * Firestore, Socket.IO or the job scheduler.
 *
 * Construction order (each layer may only depend on layers above it):
 *   1. infrastructure  — clock, health registry
 *   2. adapters        — datastore, identity provider, telemetry provider    (1, 2, 5)
 *   3. repositories                                                          (1)
 *   4. domain engines  — pure, no dependencies                               (7, 8)
 *   5. services        — orchestration over repositories + engines           (3–9)
 *   6. middleware + controllers                                              (2, 10)
 *   7. jobs + realtime — started last, stopped first                         (5, 6, 9)
 */
export interface AppContainer extends BaseContainer {
  readonly datastore: IDatastore;
  readonly authProvider: IAuthPort;
  readonly telemetryProvider: INetworkTelemetryPort;
  readonly scheduler: JobScheduler;
  /**
   * Runtime switch for automatic arbitration.
   *
   * Mutable by design: an operator may need to suspend automatic action during a planned
   * maintenance window, and a test needs to drive the loop deterministically. Exposed as an
   * object rather than a boolean so the value is read at call time, not captured at wiring
   * time.
   */
  readonly autoArbitration: { enabled: boolean };

  readonly repositories: {
    users: UserRepository;
    departments: DepartmentRepository;
    policies: PolicyRepository;
    slices: SliceRepository;
    telemetry: TelemetryRepository;
    contention: ContentionRepository;
    arbitration: ArbitrationRepository;
  };

  readonly services: {
    audit: AuditService;
    tokens: TokenService;
    users: UserService;
    auth: AuthService;
    departments: DepartmentService;
    policies: PolicyService;
    slices: SliceService;
    telemetry: TelemetryService;
    capacity: CapacityService;
    contention: ContentionService;
    notifications: NotificationService;
    allocation: AllocationService;
    arbitration: ArbitrationService;
    settings: SettingsService;
  };

  readonly middleware: {
    auth: AuthMiddleware;
  };

  readonly controllers: {
    auth: AuthController;
    users: UserController;
    departments: DepartmentController;
    policies: PolicyController;
    slices: SliceController;
    telemetry: TelemetryController;
    capacity: CapacityController;
    contention: ContentionController;
    arbitration: ArbitrationController;
    audit: AuditController;
    settings: SettingsController;
  };

  readonly realtime: RealtimeGateway;

  /** Mounts added outside the versioned API prefix (Swagger UI). */
  extraMounts: { path: string; router: Router }[];
  /** Starts background schedulers. No-op when `ENABLE_JOBS=false`. */
  startJobs(): Promise<void>;
  /** Attaches the Socket.IO server to the HTTP server, if realtime is enabled. */
  attachRealtime(server: http.Server): void;
}

export interface BuildOptions extends ContainerOverrides {
  /** Suppresses schedulers and realtime — used by integration tests. */
  headless?: boolean;
  datastore?: DatastoreFactoryOptions;
  telemetry?: TelemetryFactoryOptions;
  /**
   * Whether a confirmed contention automatically triggers arbitration.
   *
   * Defaults to `AUTO_ARBITRATION` in normal operation, and to OFF under `headless` so
   * integration tests can drive arbitration explicitly and assert on a specific decision.
   * Toggleable at runtime through `container.autoArbitration` — the automatic path is
   * itself covered by a test that switches it on.
   */
  autoArbitration?: boolean;
}

export async function buildContainer(options: BuildOptions = {}): Promise<AppContainer> {
  const base = createBaseContainer(options);

  /* ---- 1. Infrastructure ------------------------------------------- */
  base.health.register('process', () => ({
    status: 'up',
    details: {
      uptimeSeconds: Math.floor(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  }));

  /* ---- 2. Adapters -------------------------------------------------- */
  const datastore = await createDatastore(options.datastore ?? {});
  base.registerDisposer('datastore', () => datastore.dispose());
  base.health.register('datastore', async () => {
    await datastore.ping();
    return { status: 'up', details: { driver: datastore.driver } };
  });

  const authProvider = await createAuthProvider({ clock: base.clock });
  base.health.register(
    'identity-provider',
    async () => {
      await authProvider.ping();
      return { status: 'up', details: { provider: authProvider.name } };
    },
    // Non-critical: an identity-provider outage blocks new sign-ins but must not pull the
    // instance out of rotation. Existing sessions keep working, and — more importantly —
    // the arbitration control loop keeps protecting the network.
    { critical: false },
  );

  const telemetryProvider = await createTelemetryProvider(options.telemetry ?? {});
  if (telemetryProvider.dispose) {
    base.registerDisposer('telemetry-provider', () => telemetryProvider.dispose!());
  }

  /* ---- 3. Repositories ---------------------------------------------- */
  const repositories = {
    users: new UserRepository(datastore),
    departments: new DepartmentRepository(datastore),
    policies: new PolicyRepository(datastore),
    slices: new SliceRepository(datastore),
    telemetry: new TelemetryRepository(datastore),
    contention: new ContentionRepository(datastore),
    arbitration: new ArbitrationRepository(datastore),
  };

  /* ---- 4. Domain engines (Modules 7 & 8) ---------------------------- */

  /* ---- 5. Services --------------------------------------------------- */
  const audit = new AuditService(datastore, base.clock);
  base.health.register('audit-writer', audit.healthProbe, { critical: false });

  const tokens = new TokenService(base.clock);
  const users = new UserService(repositories.users, datastore, audit, base.clock, authProvider);
  const auth = new AuthService(authProvider, users, tokens, audit, base.clock);
  const departments = new DepartmentService(repositories.departments, datastore, audit);
  const policies = new PolicyService(repositories.policies, datastore, audit, base.clock);
  const slices = new SliceService(
    repositories.slices,
    repositories.departments,
    datastore,
    audit,
    base.clock,
  );

  const telemetry = new TelemetryService(
    telemetryProvider,
    repositories.slices,
    repositories.telemetry,
    base.clock,
  );
  // Critical: a stalled telemetry loop means arbitration would act on a frozen view of the
  // network, which is more dangerous than not arbitrating at all.
  base.health.register('telemetry', telemetry.healthProbe, { critical: true });

  const capacity = new CapacityService(datastore, base.clock);
  base.health.register('capacity', capacity.healthProbe, { critical: false });

  const contention = new ContentionService(repositories.contention, audit, base.clock);
  await contention.initialise();
  // An open contention is a network condition, not a platform fault — non-critical so it
  // shows on the health endpoint without failing a readiness gate.
  base.health.register('contention', contention.healthProbe, { critical: false });

  /**
   * THE CONTROL LOOP IS WIRED HERE.
   *
   * Telemetry emits a snapshot; the capacity monitor folds it into a network-wide
   * measurement; the contention detector decides whether that measurement warrants action.
   * Each stage depends only on the previous one's output, so a new consumer (the realtime
   * gateway in Module 10) subscribes without any stage knowing about it.
   *
   * The handler is deliberately fire-and-forget with its own error containment: an
   * exception here must not propagate back into the telemetry emitter and abort the tick
   * for every other subscriber.
   */
  const notifications = new NotificationService(datastore, base.clock);

  const allocation = new AllocationService(
    repositories.slices,
    repositories.arbitration,
    datastore,
    telemetryProvider,
    audit,
    notifications,
    base.clock,
  );

  const arbitration = new ArbitrationService(
    repositories.slices,
    repositories.departments,
    repositories.arbitration,
    policies,
    telemetry,
    contention,
    allocation,
    audit,
    notifications,
    base.clock,
  );

  /**
   * THE CONTROL LOOP IS WIRED HERE.
   *
   * Telemetry emits a snapshot; the capacity monitor folds it into a network-wide
   * measurement; the contention detector decides whether that measurement warrants action;
   * the arbitration engine acts. Each stage depends only on the previous one's output, so a
   * new consumer (the realtime gateway in Module 10) subscribes without any stage knowing
   * about it.
   *
   * The handler is fire-and-forget with its own error containment: an exception here must
   * not propagate back into the telemetry emitter and abort the tick for every other
   * subscriber.
   */
  const autoArbitration = {
    enabled: options.autoArbitration ?? (env.AUTO_ARBITRATION && options.headless !== true),
  };

  // Constructed here rather than in the jobs section because the settings controller
  // exposes its statistics on `/settings/system`, and controllers are wired below.
  const scheduler = new JobScheduler();

  telemetry.on('snapshot', (snapshot) => {
    void (async () => {
      try {
        const capacityState = capacity.ingest(snapshot);
        await capacity.persistIfDue();

        const event = await contention.evaluate(snapshot, capacityState);
        if (!event || !autoArbitration.enabled) return;

        // The gate is re-checked inside `run`, but checking here avoids constructing the
        // whole candidate set every tick while a cooldown is active.
        if (!contention.canArbitrate(event).allowed) return;

        await arbitration.run(event);
      } catch (error) {
        log.error({ err: error }, 'control loop stage failed');
      }
    })();
  });

  const settings = new SettingsService(datastore, audit, autoArbitration);
  await settings.initialise();

  const services = {
    audit,
    tokens,
    users,
    auth,
    departments,
    policies,
    slices,
    telemetry,
    capacity,
    contention,
    notifications,
    allocation,
    arbitration,
    settings,
  };

  /* ---- Realtime fan-out ---------------------------------------------- */
  const realtime = new RealtimeGateway(tokens);
  base.registerDisposer('realtime', () => realtime.dispose());

  // Subscribed AFTER the control-loop handler so the dashboard is fed from the same events
  // the engine consumes, rather than from a separate query that could disagree with it.
  telemetry.on('snapshot', (snapshot) => {
    realtime.publishTelemetry(snapshot);
    const state = capacity.getState();
    if (state) realtime.publishCapacity(state);
  });

  contention.on('detected', (event) => realtime.publishContentionOpened(event));
  contention.on('updated', (event) => realtime.publishContentionUpdated(event));
  contention.on('resolved', (event) => realtime.publishContentionResolved(event));
  notifications.on('created', (notification) => realtime.publishNotification(notification));

  /* ---- 6. Middleware & controllers ----------------------------------- */
  const middleware = {
    auth: createAuthMiddleware({ tokens, users }),
  };

  const controllers = {
    auth: createAuthController({ auth }),
    users: createUserController({ users }),
    departments: createDepartmentController({ departments }),
    policies: createPolicyController({ policies }),
    slices: createSliceController({ slices }),
    telemetry: createTelemetryController({
      telemetry,
      repository: repositories.telemetry,
      clock: base.clock,
    }),
    capacity: createCapacityController({ capacity, slices, clock: base.clock }),
    contention: createContentionController({ contention }),
    arbitration: createArbitrationController({ arbitration, contention }),
    audit: createAuditController({ audit, notifications }),
    settings: createSettingsController({
      settings,
      telemetry,
      capacity,
      contention,
      arbitration,
      slices,
      departments,
      scheduler,
      autoArbitration,
    }),
    testbed: createTestbedController({
      autoArbitration,
      telemetryProvider,
      slices: repositories.slices,
      telemetryService: telemetry,
      auditService: audit,
      contention,
    }),
  };

  const extraMounts: { path: string; router: Router }[] = [];

  if (env.SWAGGER_ENABLED) {
    const docsRouter = Router();
    const document = buildOpenApiDocument();

    // The raw document is served alongside the UI so integrators can generate clients.
    docsRouter.get('/openapi.json', (_req, res) => res.json(document));
    docsRouter.use(
      '/',
      swaggerUi.serve,
      swaggerUi.setup(document, {
        customSiteTitle: 'Arbitration Platform API',
        swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
      }),
    );

    extraMounts.push({ path: env.SWAGGER_PATH, router: docsRouter });
  }

  /* ---- 7. Jobs -------------------------------------------------------- */
  scheduler.register({
    name: 'telemetry-tick',
    intervalMs: env.TELEMETRY_TICK_MS,
    // A short stagger lets the datastore finish initialising before the first read, and
    // avoids every job in a multi-instance deployment firing in the same millisecond.
    initialDelayMs: 250,
    run: async () => {
      await telemetry.collect();
    },
  });

  /**
   * Recovery sweep.
   *
   * Restores slices whose degradation window has expired. Runs on its own cadence rather
   * than inside the telemetry tick because recovery is not conditional on observing the
   * network — a degradation must expire on schedule even if telemetry is temporarily
   * unavailable, or a slice could stay degraded indefinitely because of an unrelated fault.
   */
  scheduler.register({
    name: 'recovery-sweep',
    intervalMs: env.RECOVERY_SCAN_MS,
    initialDelayMs: 2000,
    run: async () => {
      const result = await allocation.recoverExpired();
      if (result.slicesRestored > 0) {
        log.info(result, 'recovery sweep restored slices');
      }
    },
  });

  scheduler.register({
    name: 'telemetry-retention',
    intervalMs: env.RETENTION_SWEEP_MS,
    initialDelayMs: 60_000,
    enabled: () => env.TELEMETRY_PERSIST,
    run: async () => {
      const now = base.clock.now();

      const telemetryRemoved = await repositories.telemetry.pruneOlderThan(
        now - RETENTION_HOURS * 60 * 60 * 1000,
      );
      const capacityRemoved = await capacity.pruneOlderThan(
        now - CAPACITY_RETENTION_HOURS * 60 * 60 * 1000,
      );
      const notificationsRemoved = await notifications.pruneOlderThan(
        now - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );

      if (telemetryRemoved + capacityRemoved + notificationsRemoved > 0) {
        log.info(
          { telemetryRemoved, capacityRemoved, notificationsRemoved },
          'retention sweep completed (audit logs are never pruned)',
        );
      }
    },
  });

  base.registerDisposer('scheduler', () => scheduler.stop());

  const container: AppContainer = {
    ...base,
    datastore,
    authProvider,
    telemetryProvider,
    scheduler,
    autoArbitration,
    realtime,
    repositories,
    services,
    middleware,
    controllers,
    extraMounts,

    async startJobs(): Promise<void> {
      if (!env.ENABLE_JOBS || options.headless) {
        log.warn(
          { enableJobs: env.ENABLE_JOBS, headless: options.headless === true },
          'background jobs are DISABLED; telemetry will not advance and no arbitration will occur',
        );
        return;
      }
      scheduler.start();

      if (telemetryProvider.name === 'gateway' && (telemetryProvider as any).pushCatalogue) {
        const syncCatalogue = async (): Promise<boolean> => {
          try {
            const allSlices = await repositories.slices.listAll();
            if (allSlices.length > 0) {
              const cat = allSlices.map((s) => {
                const jc = s.tags.find((t) => t.startsWith('join:'))?.slice(5) || s.code.slice(0, 6).toUpperCase();
                return {
                  code: s.code,
                  name: s.name,
                  department: s.departmentId,
                  sNssai: s.snssai,
                  profile: s.profile,
                  baselineKbps: s.baselineAllocatedMbps,
                  floorKbps: s.minGuaranteedMbps,
                  burstKbps: s.maxBurstMbps,
                  currentLimitKbps: s.baselineAllocatedMbps,
                  slaTargets: {
                    latencyMs: s.slaTargets.maxLatencyMs,
                    jitterMs: s.slaTargets.maxJitterMs,
                    lossPct: s.slaTargets.maxPacketLossPercent,
                    minThroughputKbps: s.slaTargets.minThroughputMbps,
                    availabilityPct: s.slaTargets.availabilityPercent,
                  },
                  joinCode: jc,
                };
              });
              await (telemetryProvider as any).pushCatalogue(cat);
              log.info({ slices: cat.length }, 'gateway catalogue synchronized');
              return true;
            }
            return false;
          } catch (err: any) {
            return false;
          }
        };

        syncCatalogue().then((ok) => {
          if (!ok) {
            const timer = setInterval(async () => {
              const success = await syncCatalogue();
              if (success) clearInterval(timer);
            }, 3000);
          }
        });
      }
    },

    attachRealtime(server: http.Server): void {
      if (options.headless) return;
      realtime.attach(server);
    },
  };

  log.info(
    {
      headless: options.headless === true,
      datastore: datastore.driver,
      authProvider: authProvider.name,
      telemetryProvider: telemetryProvider.name,
      jobs: scheduler.stats().map((s) => s.name),
    },
    'container assembled',
  );
  return container;
}

/** Telemetry retention window, in hours. */
const RETENTION_HOURS = 24;
/** Capacity snapshots are kept longer: they feed capacity-planning conversations. */
const CAPACITY_RETENTION_HOURS = 72;
const NOTIFICATION_RETENTION_DAYS = 30;
