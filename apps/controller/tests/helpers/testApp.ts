import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '@/app';
import { buildContainer, type AppContainer } from '@/bootstrap';
import { buildApiRouter } from '@/routes';
import { FixedClock } from '@/interfaces/clock.port';
import { env } from '@/config/env';
import { ALL_COLLECTIONS } from '@/constants/collections';
import type { UserRole } from '@/constants/enums';
import { MemoryDatastore } from '@/repositories/memory/memory.datastore';

/**
 * Integration test harness.
 *
 * Builds the REAL application — real middleware stack, real router tree, real error
 * handler, real services — with background jobs suppressed and a deterministic clock.
 * Nothing is stubbed at the HTTP layer, so these tests catch middleware-ordering and
 * authorisation-wiring regressions that unit tests structurally cannot.
 */
export interface TestHarness {
  app: Express;
  container: AppContainer;
  clock: FixedClock;
  /** Sign in through the real endpoints and return usable tokens. */
  signIn(email: string, displayName?: string): Promise<SignedInUser>;
  /** Sign in and force the account to a role, bypassing the admin-only route. */
  signInAs(role: UserRole, email?: string): Promise<SignedInUser>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SignedInUser {
  userId: string;
  email: string;
  role: UserRole;
  accessToken: string;
  refreshToken: string;
  auth: string;
}

export async function createTestHarness(): Promise<TestHarness> {
  // Today's date, pinned to 14:00 UTC.
  //
  // The DATE tracks the present so hand-built JWTs in tests stay comparable with tokens the
  // app issues. The HOUR is pinned because the synthetic traffic model applies a diurnal
  // load curve spanning roughly 4× between the overnight trough and the afternoon peak —
  // so an unpinned clock makes every load-dependent assertion pass or fail depending on
  // what time the suite happens to run.
  const today = new Date();
  const clock = new FixedClock(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 14, 0, 0),
  );
  const container = await buildContainer({
    headless: true,
    clock,
    datastore: { memory: { persist: false } },
  });

  const app = createApp({
    health: container.health,
    startedAt: container.startedAt,
    apiRouter: buildApiRouter(container),
    extraMounts: container.extraMounts,
  });

  const signIn = async (email: string, displayName?: string): Promise<SignedInUser> => {
    const res = await request(app)
      .post(`${env.API_PREFIX}/auth/dev-login`)
      .send({ email, ...(displayName ? { displayName } : {}) })
      .expect(200);

    const { user, session } = res.body.data;
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      auth: `Bearer ${session.accessToken}`,
    };
  };

  const signInAs = async (role: UserRole, email?: string): Promise<SignedInUser> => {
    const address = email ?? `${role.toLowerCase()}@corp.example`;
    const signed = await signIn(address);

    if (signed.role !== role) {
      // Promote directly through the repository. Going through the API would require an
      // existing administrator, which is precisely the chicken-and-egg the bootstrap
      // variable exists to solve in production — but tests should not depend on it.
      await container.repositories.users.base.update(signed.userId, { role });
      // Re-issue the session so the token carries the new role.
      const reissued = await signIn(address);
      return { ...reissued, role };
    }

    return signed;
  };

  const reset = async (): Promise<void> => {
    // The telemetry snapshot lives in memory, so wiping the datastore alone would leave a
    // previous test's view of the network visible to the next one.
    container.services.telemetry.clearSnapshot();
    // Restore the deterministic default; a test that switched auto-arbitration on must not
    // leak that into the next one.
    container.autoArbitration.enabled = false;
    // The settings singleton is cached in memory and is about to be wiped from the store.
    container.services.settings.invalidateCache();
    container.services.policies.invalidateCache();

    const datastore = container.datastore;
    if (datastore instanceof MemoryDatastore) {
      await datastore.reset();
      return;
    }
    for (const name of ALL_COLLECTIONS) {
      const repo = datastore.repository(name);
      const rows = await repo.findMany();
      for (const row of rows) await repo.delete(row.id);
    }
  };

  return {
    app,
    container,
    clock,
    signIn,
    signInAs,
    reset,
    dispose: () => container.shutdown(),
  };
}
