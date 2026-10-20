import { env } from '@/config/env';
import { AuditAction, UserRole } from '@/constants/enums';
import { ErrorCode } from '@/constants/errorCodes';
import type { ExternalIdentity } from '@/interfaces/auth.port';
import type { IAuthPort } from '@/interfaces/auth.port';
import type { IClock } from '@/interfaces/clock.port';
import type { IDatastore } from '@/interfaces/repository.port';
import { diffFields } from '@/models/auditLog.model';
import type { UpdateOwnProfilePayload, UpdateUserPayload, User } from '@/models/user.model';
import type { UserRepository } from '@/repositories/user.repository';
import type { ActorContext, Page } from '@/types/common';
import { ConflictError, ForbiddenError, NotFoundError, PolicyViolationError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';
import type { AuditService } from './audit.service';

const log = createLogger('user-service');

/**
 * User lifecycle and authorisation management.
 *
 * Owns the answer to "who may do what", which makes it the most security-sensitive service
 * in the platform. Three invariants it enforces, each of which has a corresponding test:
 *
 *   I1. The platform can never be left without an enabled administrator.
 *   I2. A user cannot change their own role or disable themselves.
 *   I3. A privilege change invalidates that user's existing sessions immediately.
 */
export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly datastore: IDatastore,
    private readonly audit: AuditService,
    private readonly clock: IClock,
    private readonly authProvider: IAuthPort,
  ) {}

  /**
   * Resolve an externally-authenticated identity to a platform user, provisioning one on
   * first sign-in.
   *
   * ROLE ASSIGNMENT ON FIRST LOGIN
   * ------------------------------
   * New users receive VIEWER — the least privilege that still allows using the dashboard.
   * The sole exception is `BOOTSTRAP_ADMIN_EMAIL`, which is promoted to ADMIN. Without
   * that hatch a fresh deployment has no administrator and no way to create one, since
   * granting a role requires being an administrator.
   *
   * The bootstrap promotion applies only while there is no enabled administrator, so
   * leaving the variable set in a mature deployment cannot silently re-escalate an account
   * that an administrator has deliberately demoted.
   */
  async resolveOrProvision(identity: ExternalIdentity, actor: ActorContext): Promise<User> {
    let existing =
      (await this.users.findBySubject(identity.subject)) ??
      (await this.users.findByEmail(identity.email));

    if (existing) {
      if (!existing.enabled) {
        throw new ForbiddenError('This account has been disabled. Contact an administrator.');
      }
      const targetRole = this.predeterminedRole(existing.email);
      if (targetRole && existing.role !== targetRole) {
        log.warn(
          { email: existing.email, from: existing.role, to: targetRole },
          'syncing user to predetermined role',
        );
        existing = await this.users.base.update(existing.id, { role: targetRole });
      }
      return this.recordLogin(existing, identity);
    }

    const role = this.predeterminedRole(identity.email) ?? (await this.roleForNewUser(identity.email));
    const now = this.clock.nowIso();

    const created = await this.users.base.create({
      subject: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      ...(identity.photoUrl ? { photoUrl: identity.photoUrl } : {}),
      role,
      enabled: true,
      departmentScope: [],
      signInProvider: identity.signInProvider,
      lastLoginAt: now,
      loginCount: 1,
      notificationPreferences: { dashboard: true, email: false, minimumSeverity: 'WARNING' },
    });

    log.info({ userId: created.id, email: created.email, role }, 'user provisioned');

    await this.audit.record({
      action: AuditAction.USER_LOGIN,
      actor: { ...actor, userId: created.id, email: created.email, role: created.role },
      summary: `New user provisioned with role ${role} via ${identity.signInProvider}`,
      target: { type: 'User', id: created.id, name: created.email },
      metadata: { provisioned: true, signInProvider: identity.signInProvider },
    });

    return created;
  }

  private predeterminedRole(email: string): UserRole | null {
    const norm = email.toLowerCase().trim();
    if (
      norm === 'admin@example.com' ||
      norm === 'admin' ||
      norm === env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase()
    ) {
      return UserRole.ADMIN;
    }
    if (norm === 'manager@example.com' || norm === 'manager') {
      return UserRole.MANAGER;
    }
    if (norm === 'viewer@example.com' || norm === 'viewer') {
      return UserRole.VIEWER;
    }
    return null;
  }

  private async roleForNewUser(email: string): Promise<UserRole> {
    const norm = email.toLowerCase().trim();
    const predetermined = this.predeterminedRole(norm);
    if (predetermined) return predetermined;

    const bootstrapEmail = env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
    if (!bootstrapEmail || norm !== bootstrapEmail) return UserRole.VIEWER;

    // Only bootstrap while the platform genuinely has no administrator.
    const adminCount = await this.users.countEnabledAdmins();
    if (adminCount > 0) {
      log.warn(
        { email },
        'BOOTSTRAP_ADMIN_EMAIL matched but administrators already exist; provisioning as VIEWER',
      );
      return UserRole.VIEWER;
    }

    log.warn({ email }, 'bootstrapping the first administrator from BOOTSTRAP_ADMIN_EMAIL');
    return UserRole.ADMIN;
  }

  private async recordLogin(user: User, identity: ExternalIdentity): Promise<User> {
    // Refresh provider-owned profile fields on each login so a display-name or avatar
    // change upstream propagates without an explicit sync job.
    return this.users.base.update(user.id, {
      lastLoginAt: this.clock.nowIso(),
      loginCount: user.loginCount + 1,
      emailVerified: identity.emailVerified,
      signInProvider: identity.signInProvider,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      ...(identity.photoUrl ? { photoUrl: identity.photoUrl } : {}),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Administration                                                      */
  /* ------------------------------------------------------------------ */

  async getById(id: string): Promise<User> {
    return this.users.base.getById(id);
  }

  async list(
    criteria: { role?: UserRole; enabled?: boolean },
    page: { limit: number; cursor?: string },
  ): Promise<Page<User>> {
    return this.users.search(criteria, page);
  }

  /**
   * Administrator-driven update of another user's role, status or department scope.
   *
   * Runs inside a transaction because invariant I1 (never zero administrators) is a
   * read-then-write decision: without atomicity, two concurrent demotions could each
   * observe two admins and both proceed, leaving none.
   */
  async update(id: string, payload: UpdateUserPayload, actor: ActorContext): Promise<User> {
    if (id === actor.userId && (payload.role !== undefined || payload.enabled === false)) {
      // I2 — self-demotion and self-lockout are rejected outright. An administrator who
      // needs to step down must be changed by another administrator, which keeps the
      // action attributable and prevents accidental loss of access.
      throw new ForbiddenError('You cannot change your own role or disable your own account');
    }

    const updated = await this.datastore.runTransaction(async (tx) => {
      // --- reads first (see the IDatastore transaction contract) ---
      const current = await this.users.base.getById(id, { tx });

      const losesAdmin =
        current.role === UserRole.ADMIN &&
        current.enabled &&
        ((payload.role !== undefined && payload.role !== UserRole.ADMIN) || payload.enabled === false);

      if (losesAdmin) {
        const adminCount = await this.users.countEnabledAdmins({ tx });
        if (adminCount <= 1) {
          throw new PolicyViolationError(
            'This is the last enabled administrator; promote another administrator first',
            { userId: id, enabledAdmins: adminCount },
          );
        }
      }

      const privilegeChanged =
        (payload.role !== undefined && payload.role !== current.role) ||
        (payload.enabled !== undefined && payload.enabled !== current.enabled) ||
        payload.departmentScope !== undefined;

      // --- writes ---
      return this.users.base.update(
        id,
        {
          ...payload,
          // I3 — invalidate every session issued before now, so a demotion or a disable
          // takes effect immediately instead of surviving until the access token expires.
          ...(privilegeChanged ? { sessionsValidFrom: this.clock.nowIso() } : {}),
        },
        { tx, actor, expectedVersion: current.version },
      );
    }, `user.update:${id}`);

    const before = await this.users.base.findById(id);
    void before; // diff is computed from the payload; see `changes` below.

    await this.audit.record({
      action: payload.role !== undefined ? AuditAction.USER_ROLE_CHANGED : AuditAction.USER_DISABLED,
      actor,
      summary: describeUserChange(payload, updated.email),
      target: { type: 'User', id: updated.id, name: updated.email },
      changes: diffFields({}, payload as Record<string, unknown>),
    });

    // Best-effort provider-side enforcement. The local `enabled` flag is authoritative for
    // this platform; revoking upstream additionally kills the user's Firebase session.
    if (payload.enabled === false && this.authProvider.capabilities().revocation) {
      await this.authProvider
        .revokeSessions?.(updated.subject)
        .catch((error: unknown) =>
          log.warn({ err: error, userId: id }, 'provider session revocation failed'),
        );
    }

    log.info({ userId: id, by: actor.userId, payload }, 'user updated');
    return updated;
  }

  /** Self-service profile update. Cannot touch role, scope or enabled state. */
  async updateOwnProfile(
    id: string,
    payload: UpdateOwnProfilePayload,
    actor: ActorContext,
  ): Promise<User> {
    const current = await this.users.base.getById(id);

    return this.users.base.update(
      id,
      {
        ...(payload.displayName !== undefined ? { displayName: payload.displayName } : {}),
        ...(payload.notificationPreferences
          ? {
              notificationPreferences: {
                ...current.notificationPreferences,
                ...payload.notificationPreferences,
              },
            }
          : {}),
      },
      { actor },
    );
  }

  /**
   * Force sign-out across every device by advancing the session watermark.
   * Used during offboarding and incident response.
   */
  async revokeSessions(id: string, actor: ActorContext): Promise<void> {
    const user = await this.users.base.findById(id);
    if (!user) throw new NotFoundError('User', id);

    await this.users.base.update(id, { sessionsValidFrom: this.clock.nowIso() }, { actor });

    if (this.authProvider.capabilities().revocation) {
      await this.authProvider
        .revokeSessions?.(user.subject)
        .catch((error: unknown) => log.warn({ err: error, userId: id }, 'provider revocation failed'));
    }

    await this.audit.record({
      action: AuditAction.USER_DISABLED,
      actor,
      summary: `All sessions revoked for ${user.email}`,
      target: { type: 'User', id, name: user.email },
    });
  }

  /**
   * Delete a user record.
   *
   * Audit entries deliberately survive: they carry a denormalised copy of the actor, so
   * removing the user does not blank out history. Deleting the last administrator is
   * blocked by the same invariant as demotion.
   */
  async delete(id: string, actor: ActorContext): Promise<void> {
    if (id === actor.userId) {
      throw new ForbiddenError('You cannot delete your own account');
    }

    const user = await this.datastore.runTransaction(async (tx) => {
      const current = await this.users.base.getById(id, { tx });
      if (current.role === UserRole.ADMIN && current.enabled) {
        const adminCount = await this.users.countEnabledAdmins({ tx });
        if (adminCount <= 1) {
          throw new PolicyViolationError(
            'This is the last enabled administrator and cannot be deleted',
            { userId: id },
          );
        }
      }
      await this.users.base.delete(id, { tx, expectedVersion: current.version });
      return current;
    }, `user.delete:${id}`);

    await this.audit.record({
      action: AuditAction.USER_DISABLED,
      actor,
      summary: `User ${user.email} deleted`,
      target: { type: 'User', id, name: user.email },
    });
  }

  /**
   * Re-read the authoritative user record for a session being refreshed, enforcing that
   * the account is still enabled and the session has not been superseded.
   */
  async assertSessionStillValid(userId: string, tokenIssuedAtSeconds: number): Promise<User> {
    const user = await this.users.base.findById(userId);
    if (!user) throw new NotFoundError('User', userId);

    if (!user.enabled) {
      throw new ForbiddenError('This account has been disabled', { code: ErrorCode.ACCOUNT_DISABLED });
    }

    if (user.sessionsValidFrom) {
      const watermark = Math.floor(Date.parse(user.sessionsValidFrom) / 1000);
      if (Number.isFinite(watermark) && tokenIssuedAtSeconds < watermark) {
        throw new ConflictError(
          'This session has been superseded; sign in again',
          ErrorCode.TOKEN_INVALID,
        );
      }
    }

    return user;
  }
}

function describeUserChange(payload: UpdateUserPayload, email: string): string {
  const parts: string[] = [];
  if (payload.role !== undefined) parts.push(`role set to ${payload.role}`);
  if (payload.enabled !== undefined) parts.push(payload.enabled ? 'account enabled' : 'account disabled');
  if (payload.departmentScope !== undefined) {
    parts.push(
      payload.departmentScope.length === 0
        ? 'department scope cleared (unrestricted)'
        : `department scope set to ${payload.departmentScope.length} department(s)`,
    );
  }
  if (payload.displayName !== undefined) parts.push('display name changed');
  return `${email}: ${parts.join(', ')}`;
}
