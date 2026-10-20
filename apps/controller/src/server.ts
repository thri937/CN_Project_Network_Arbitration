import http from 'node:http';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { buildContainer, type AppContainer } from '@/bootstrap';
import { buildApiRouter } from '@/routes';
import { createLogger } from '@/utils/logger';

const log = createLogger('server');

/**
 * Process entry point.
 *
 * Responsibilities kept strictly here and nowhere else:
 *   - build the container (wire adapters),
 *   - build and start the HTTP server,
 *   - start background jobs,
 *   - handle signals and fatal errors,
 *   - shut down gracefully.
 *
 * GRACEFUL SHUTDOWN MATTERS HERE more than in a typical CRUD service: an arbitration run
 * may be mid-flight, holding a partially applied allocation. Stopping the schedulers and
 * letting in-flight work drain before closing the datastore is what prevents a slice from
 * being left degraded with no corresponding audit record.
 */

const SHUTDOWN_GRACE_MS = 15_000;

async function main(): Promise<void> {
  const container: AppContainer = await buildContainer();

  const app = createApp({
    health: container.health,
    startedAt: container.startedAt,
    apiRouter: buildApiRouter(container),
    extraMounts: container.extraMounts,
  });

  const server = http.createServer(app);

  // Keep-alive must exceed the upstream proxy's idle timeout, otherwise the proxy can
  // reuse a socket that Node is simultaneously closing → sporadic 502s.
  server.keepAliveTimeout = 72_000;
  server.headersTimeout = 75_000;

  container.attachRealtime?.(server);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, env.HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  log.info(
    {
      port: env.PORT,
      host: env.HOST,
      apiPrefix: env.API_PREFIX,
      datastore: env.DATASTORE_DRIVER,
      auth: env.AUTH_DRIVER,
      telemetry: env.TELEMETRY_PROVIDER,
      jobs: env.ENABLE_JOBS,
    },
    `Arbitration backend listening on http://${env.HOST}:${env.PORT}${env.API_PREFIX}`,
  );

  if (env.SWAGGER_ENABLED) {
    log.info(`API documentation available at http://localhost:${env.PORT}${env.SWAGGER_PATH}`);
  }

  await container.startJobs?.();

  installShutdownHandlers(server, container);
}

function installShutdownHandlers(server: http.Server, container: AppContainer): void {
  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      log.warn({ signal }, 'shutdown already in progress; ignoring');
      return;
    }
    shuttingDown = true;
    log.info({ signal }, 'graceful shutdown initiated');

    // Hard deadline: if draining stalls (a hung upstream call, a wedged socket), exit
    // anyway. An orchestrator will SIGKILL us shortly regardless; exiting on our own terms
    // at least lets the final log lines flush.
    const deadline = setTimeout(() => {
      log.fatal({ graceMs: SHUTDOWN_GRACE_MS }, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    deadline.unref();

    try {
      // 1. Stop accepting new connections (existing ones drain).
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // 2. Stop schedulers, then dispose adapters in reverse construction order.
      await container.shutdown();
      clearTimeout(deadline);
      log.info('shutdown complete');
      process.exit(exitCode);
    } catch (error) {
      log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection means the process is in an unknown state. Log it with full
  // context and shut down rather than limping on and making incorrect arbitration
  // decisions from corrupted state.
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'failed to start server');
  process.exit(1);
});
