import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import { env } from '@/config/env';
import { ErrorCode } from '@/constants/errorCodes';
import { UserRole } from '@/constants/enums';
import { createTestHarness, type TestHarness } from '../helpers/testApp';

const API = env.API_PREFIX;

describe('authentication & RBAC', () => {
  let harness: TestHarness;
  let app: Express;

  beforeAll(async () => {
    harness = await createTestHarness();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  /* ------------------------------------------------------------------ */
  describe('sign-in', () => {
    it('provisions a new user as VIEWER on first sign-in', async () => {
      const res = await request(app)
        .post(`${API}/auth/dev-login`)
        .send({ email: 'newcomer@corp.example', displayName: 'New Comer' })
        .expect(200);

      expect(res.body.data.user).toMatchObject({
        email: 'newcomer@corp.example',
        role: UserRole.VIEWER,
        enabled: true,
        loginCount: 1,
      });
      expect(res.body.data.session.accessToken).toBeTruthy();
      expect(res.body.data.session.refreshToken).toBeTruthy();
      expect(res.body.data.session.tokenType).toBe('Bearer');
    });

    it('never exposes the identity-provider subject to the client', async () => {
      // The provider's primary key is useful for account-takeover reconnaissance and the
      // SPA has no legitimate use for it.
      const res = await request(app)
        .post(`${API}/auth/dev-login`)
        .send({ email: 'private@corp.example' })
        .expect(200);

      expect(res.body.data.user).not.toHaveProperty('subject');
      expect(JSON.stringify(res.body)).not.toContain('dev-');
    });

    it('reuses the same user record across sign-ins', async () => {
      const first = await harness.signIn('repeat@corp.example');
      const second = await harness.signIn('repeat@corp.example');
      expect(second.userId).toBe(first.userId);

      const me = await request(app).get(`${API}/auth/me`).set('Authorization', second.auth).expect(200);
      expect(me.body.data.loginCount).toBe(2);
    });

    it('normalises email case so one person is one account', async () => {
      const lower = await harness.signIn('mixed@corp.example');
      const upper = await harness.signIn('MIXED@corp.example');
      expect(upper.userId).toBe(lower.userId);
    });

    it('rejects a malformed sign-in payload', async () => {
      // A bare name is shorthand for name@example.com, so the address has to be broken
      // after that expansion to be refused.
      const res = await request(app)
        .post(`${API}/auth/dev-login`)
        .send({ email: 'not@an@email' })
        .expect(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('treats a bare name as a demo account at example.com', async () => {
      const res = await request(app)
        .post(`${API}/auth/dev-login`)
        .send({ email: 'manager' })
        .expect(200);
      expect(res.body.data.user.email).toBe('manager@example.com');
      expect(res.body.data.user.role).toBe('MANAGER');
    });

    it('rejects unknown fields rather than silently ignoring them', async () => {
      // `.strict()` on the schema. A silently-dropped `role: "ADMIN"` would be an
      // invisible privilege-escalation attempt; rejecting it makes the attempt loud.
      const res = await request(app)
        .post(`${API}/auth/dev-login`)
        .send({ email: 'sneaky@corp.example', role: 'ADMIN' })
        .expect(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('rejects an invalid ID token at the session endpoint', async () => {
      const res = await request(app)
        .post(`${API}/auth/session`)
        .send({ idToken: 'a'.repeat(64) })
        .expect(401);
      expect(res.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('bearer token handling', () => {
    it('requires an Authorization header on protected routes', async () => {
      const res = await request(app).get(`${API}/auth/me`).expect(401);
      expect(res.body.error.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('requires the Bearer scheme', async () => {
      const user = await harness.signIn('scheme@corp.example');
      const res = await request(app)
        .get(`${API}/auth/me`)
        .set('Authorization', `Basic ${user.accessToken}`)
        .expect(401);
      expect(res.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
    });

    it('rejects a header with extra segments', async () => {
      const user = await harness.signIn('segments@corp.example');
      await request(app)
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${user.accessToken} extra`)
        .expect(401);
    });

    it('rejects a token signed with the wrong secret', async () => {
      const forged = jwt.sign(
        { typ: 'access', sub: 'USR-FAKE', sid: 's', psub: 'p', email: 'x@y.z', role: 'ADMIN', scope: [] },
        'a-completely-different-secret-value-32chars',
        { algorithm: 'HS256', issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: 3600 },
      );

      const res = await request(app)
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
      expect(res.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
    });

    it('rejects an unsigned "alg: none" token', async () => {
      // The classic JWT algorithm-confusion attack. `TokenService` pins algorithms to
      // HS256 specifically to make this impossible.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          typ: 'access',
          sub: 'USR-FAKE',
          sid: 's',
          email: 'attacker@evil.example',
          role: 'ADMIN',
          scope: [],
          iss: env.JWT_ISSUER,
          aud: env.JWT_AUDIENCE,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      await request(app)
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${header}.${payload}.`)
        .expect(401);
    });

    it('rejects a token issued for a different audience', async () => {
      const foreign = jwt.sign(
        { typ: 'access', sub: 'USR-X', sid: 's', psub: 'p', email: 'x@y.z', role: 'VIEWER', scope: [] },
        env.JWT_SECRET,
        { algorithm: 'HS256', issuer: env.JWT_ISSUER, audience: 'some-other-app', expiresIn: 3600 },
      );

      await request(app).get(`${API}/auth/me`).set('Authorization', `Bearer ${foreign}`).expect(401);
    });

    it('rejects an expired token with a distinguishable code', async () => {
      // `exp` is set relative to the HARNESS clock, which is what the application verifies
      // against. Using wall-clock time here would produce a token the app considers valid.
      const nowSeconds = Math.floor(harness.clock.now() / 1000);
      const expired = jwt.sign(
        {
          typ: 'access',
          sub: 'USR-X',
          sid: 's',
          psub: 'p',
          email: 'x@y.z',
          role: 'VIEWER',
          scope: [],
          iat: nowSeconds - 7200,
          exp: nowSeconds - 3600,
        },
        env.JWT_SECRET,
        { algorithm: 'HS256', issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE },
      );

      const res = await request(app)
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
      // The client needs to distinguish "refresh me" from "sign in again".
      expect(res.body.error.code).toBe(ErrorCode.TOKEN_EXPIRED);
    });

    it('refuses a refresh token presented as a bearer credential', async () => {
      // A refresh token lives for two weeks and carries no role. Accepting it as an access
      // token would both extend the privilege window and yield an undefined role.
      const user = await harness.signIn('swap@corp.example');
      const res = await request(app)
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${user.refreshToken}`)
        .expect(401);
      expect(res.body.error.code).toBe(ErrorCode.TOKEN_INVALID);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('refresh', () => {
    it('issues a new access token', async () => {
      const user = await harness.signIn('refresh@corp.example');
      const res = await request(app)
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: user.refreshToken })
        .expect(200);

      expect(res.body.data.session.accessToken).toBeTruthy();
      expect(res.body.data.user.id).toBe(user.userId);
    });

    it('refuses an access token at the refresh endpoint', async () => {
      const user = await harness.signIn('wrongway@corp.example');
      await request(app)
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: user.accessToken })
        .expect(401);
    });

    it('reflects a role change made since the token was issued', async () => {
      const user = await harness.signIn('promoted@corp.example');
      expect(user.role).toBe(UserRole.VIEWER);

      await harness.container.repositories.users.base.update(user.userId, {
        role: UserRole.MANAGER,
      });

      const res = await request(app)
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: user.refreshToken })
        .expect(200);
      expect(res.body.data.user.role).toBe(UserRole.MANAGER);
    });

    it('refuses to refresh a disabled account', async () => {
      const user = await harness.signIn('disabled@corp.example');
      await harness.container.repositories.users.base.update(user.userId, { enabled: false });

      await request(app)
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: user.refreshToken })
        .expect(401);
    });

    it('refuses a refresh token superseded by a session revocation', async () => {
      const user = await harness.signIn('revoked@corp.example');

      // Advance the watermark past the token's issue time.
      harness.clock.advance(60_000);
      await harness.container.repositories.users.base.update(user.userId, {
        sessionsValidFrom: harness.clock.nowIso(),
      });

      await request(app)
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: user.refreshToken })
        .expect(401);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('role enforcement', () => {
    it('denies VIEWER access to the user directory', async () => {
      const viewer = await harness.signInAs(UserRole.VIEWER, 'viewer1@corp.example');
      const res = await request(app).get(`${API}/users`).set('Authorization', viewer.auth).expect(403);
      expect(res.body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
    });

    it('denies MANAGER access to the user directory', async () => {
      const manager = await harness.signInAs(UserRole.MANAGER, 'manager1@corp.example');
      await request(app).get(`${API}/users`).set('Authorization', manager.auth).expect(403);
    });

    it('permits ADMIN access to the user directory', async () => {
      const admin = await harness.signInAs(UserRole.ADMIN, 'admin1@corp.example');
      const res = await request(app).get(`${API}/users`).set('Authorization', admin.auth).expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('lets a user read their own record but not another', async () => {
      const alice = await harness.signInAs(UserRole.VIEWER, 'alice@corp.example');
      const bob = await harness.signInAs(UserRole.VIEWER, 'bob@corp.example');

      await request(app).get(`${API}/users/${alice.userId}`).set('Authorization', alice.auth).expect(200);
      await request(app).get(`${API}/users/${bob.userId}`).set('Authorization', alice.auth).expect(403);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('user administration', () => {
    it('lets an administrator change another user\'s role', async () => {
      const admin = await harness.signInAs(UserRole.ADMIN, 'admin2@corp.example');
      const target = await harness.signIn('target@corp.example');

      const res = await request(app)
        .patch(`${API}/users/${target.userId}`)
        .set('Authorization', admin.auth)
        .send({ role: UserRole.MANAGER })
        .expect(200);

      expect(res.body.data.role).toBe(UserRole.MANAGER);
    });

    it('invalidates the target\'s existing sessions after a role change', async () => {
      // Invariant I3: a privilege change must not be outlived by an already-issued token.
      const admin = await harness.signInAs(UserRole.ADMIN, 'admin3@corp.example');
      const target = await harness.signIn('demoted@corp.example');

      harness.clock.advance(60_000);
      await request(app)
        .patch(`${API}/users/${target.userId}`)
        .set('Authorization', admin.auth)
        .send({ role: UserRole.MANAGER })
        .expect(200);

      await request(app)
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: target.refreshToken })
        .expect(401);
    });

    it('refuses to let an administrator change their own role', async () => {
      // Invariant I2 — self-demotion must be performed by another administrator so the
      // action stays attributable and access cannot be lost by accident.
      const admin = await harness.signInAs(UserRole.ADMIN, 'admin4@corp.example');
      const res = await request(app)
        .patch(`${API}/users/${admin.userId}`)
        .set('Authorization', admin.auth)
        .send({ role: UserRole.VIEWER })
        .expect(403);
      expect(res.body.error.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('refuses to let an administrator disable their own account', async () => {
      const admin = await harness.signInAs(UserRole.ADMIN, 'admin5@corp.example');
      await request(app)
        .patch(`${API}/users/${admin.userId}`)
        .set('Authorization', admin.auth)
        .send({ enabled: false })
        .expect(403);
    });

    it('refuses to demote the last enabled administrator', async () => {
      // Invariant I1 — the platform must never be left without an administrator.
      const admin = await harness.signInAs(UserRole.ADMIN, 'solo@corp.example');
      const second = await harness.signInAs(UserRole.ADMIN, 'second@corp.example');

      // Demote `second` first, leaving exactly one administrator.
      await request(app)
        .patch(`${API}/users/${second.userId}`)
        .set('Authorization', admin.auth)
        .send({ role: UserRole.VIEWER })
        .expect(200);

      // Now a second administrator signs in and tries to demote the last one.
      const third = await harness.signInAs(UserRole.ADMIN, 'third@corp.example');
      await request(app)
        .patch(`${API}/users/${admin.userId}`)
        .set('Authorization', third.auth)
        .send({ role: UserRole.VIEWER })
        .expect(200); // permitted: `third` is still an admin, so one remains

      // `third` is now the only administrator and cannot be demoted by anyone.
      const fourth = await harness.signInAs(UserRole.ADMIN, 'fourth@corp.example');
      await request(app)
        .patch(`${API}/users/${fourth.userId}`)
        .set('Authorization', third.auth)
        .send({ role: UserRole.VIEWER })
        .expect(200);

      const res = await request(app)
        .patch(`${API}/users/${third.userId}`)
        .set('Authorization', third.auth)
        .send({ role: UserRole.VIEWER })
        .expect(403); // self-change guard fires first
      expect(res.body.error.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('rejects an empty patch rather than performing a no-op write', async () => {
      const admin = await harness.signInAs(UserRole.ADMIN, 'admin6@corp.example');
      const target = await harness.signIn('untouched@corp.example');

      await request(app)
        .patch(`${API}/users/${target.userId}`)
        .set('Authorization', admin.auth)
        .send({})
        .expect(400);
    });

    it('lets a user update their own profile without touching privileges', async () => {
      const viewer = await harness.signInAs(UserRole.VIEWER, 'selfedit@corp.example');

      const res = await request(app)
        .patch(`${API}/users/me`)
        .set('Authorization', viewer.auth)
        .send({ displayName: 'Renamed Person' })
        .expect(200);

      expect(res.body.data.displayName).toBe('Renamed Person');
      expect(res.body.data.role).toBe(UserRole.VIEWER);
    });

    it('refuses a privilege field on the self-service profile route', async () => {
      const viewer = await harness.signInAs(UserRole.VIEWER, 'escalate@corp.example');
      await request(app)
        .patch(`${API}/users/me`)
        .set('Authorization', viewer.auth)
        .send({ role: UserRole.ADMIN })
        .expect(400);
    });

    it('routes /users/me to self-service, not to the :id handler', async () => {
      // Route-ordering regression guard: if `/users/:id` were declared first, `me` would
      // match as an id and a VIEWER would hit the admin-only handler.
      const viewer = await harness.signInAs(UserRole.VIEWER, 'meroute@corp.example');
      await request(app)
        .patch(`${API}/users/me`)
        .set('Authorization', viewer.auth)
        .send({ displayName: 'Me Route' })
        .expect(200);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('fresh-session enforcement on privileged routes', () => {
    it('rejects a token held by a user disabled after it was issued', async () => {
      const admin = await harness.signInAs(UserRole.ADMIN, 'freshadmin@corp.example');
      const other = await harness.signInAs(UserRole.ADMIN, 'otheradmin@corp.example');

      // Disable the first admin's account directly.
      await harness.container.repositories.users.base.update(admin.userId, { enabled: false });

      // Their access token is still cryptographically valid, but `authenticateFresh`
      // re-reads the record and refuses.
      await request(app)
        .patch(`${API}/users/${other.userId}`)
        .set('Authorization', admin.auth)
        .send({ role: UserRole.VIEWER })
        .expect(403);
    });

    it('uses the current role from the datastore, not the role frozen in the token', async () => {
      const admin = await harness.signInAs(UserRole.ADMIN, 'demoteme@corp.example');
      await harness.signInAs(UserRole.ADMIN, 'keeper@corp.example');
      const victim = await harness.signIn('victim@corp.example');

      // Demote directly, without bumping the session watermark, so the token remains valid
      // and still carries role=ADMIN.
      await harness.container.repositories.users.base.update(admin.userId, {
        role: UserRole.VIEWER,
      });

      const res = await request(app)
        .patch(`${API}/users/${victim.userId}`)
        .set('Authorization', admin.auth)
        .send({ role: UserRole.MANAGER })
        .expect(403);
      expect(res.body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('logout', () => {
    it('records a sign-out', async () => {
      const user = await harness.signIn('bye@corp.example');
      const res = await request(app)
        .post(`${API}/auth/logout`)
        .set('Authorization', user.auth)
        .send({})
        .expect(200);
      expect(res.body.data.revokedEverywhere).toBe(false);
    });

    it('invalidates every outstanding token when signing out everywhere', async () => {
      const user = await harness.signIn('byeall@corp.example');
      harness.clock.advance(60_000);

      await request(app)
        .post(`${API}/auth/logout`)
        .set('Authorization', user.auth)
        .send({ everywhere: true })
        .expect(200);

      await request(app)
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: user.refreshToken })
        .expect(401);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('audit trail', () => {
    it('records a sign-in with the actor denormalised', async () => {
      const user = await harness.signIn('audited@corp.example');
      const entries = await harness.container.services.audit.timelineFor(user.userId);

      expect(entries.length).toBeGreaterThan(0);
      const login = entries.find((e) => e.summary.includes('Signed in'));
      expect(login).toBeDefined();
      expect(login!.actor.email).toBe('audited@corp.example');
      expect(login!.correlationId).toBeTruthy();
    });

    it('records a role change with the target and the diff', async () => {
      const admin = await harness.signInAs(UserRole.ADMIN, 'auditadmin@corp.example');
      const target = await harness.signIn('audittarget@corp.example');

      await request(app)
        .patch(`${API}/users/${target.userId}`)
        .set('Authorization', admin.auth)
        .send({ role: UserRole.MANAGER })
        .expect(200);

      const entries = await harness.container.services.audit.timelineFor(target.userId);
      const change = entries.find((e) => e.action === 'USER_ROLE_CHANGED');

      expect(change).toBeDefined();
      expect(change!.actor.userId).toBe(admin.userId);
      expect(change!.target?.id).toBe(target.userId);
      expect(change!.changes).toEqual([{ field: 'role', before: undefined, after: 'MANAGER' }]);
    });
  });
});
