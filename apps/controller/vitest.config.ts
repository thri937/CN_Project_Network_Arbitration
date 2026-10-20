import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Silent by default so a failing assertion is not buried under access logs.
    // Override with `LOG_LEVEL=debug npm test` when diagnosing a specific failure.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
      DATASTORE_DRIVER: process.env.DATASTORE_DRIVER ?? 'memory',
      AUTH_DRIVER: process.env.AUTH_DRIVER ?? 'dev',
      MEMORY_STORE_PERSIST: 'false',
    },
    // Repository adapters and jobs mutate shared module-level state (the in-memory
    // datastore, the scheduler registry). Running files in a single fork keeps that
    // deterministic without every suite having to defensively reset globals.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/docs/**', 'src/server.ts'],
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
