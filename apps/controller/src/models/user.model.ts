import { z } from 'zod';
import { USER_ROLES, UserRole } from '@/constants/enums';
import {
  auditableShape,
  displayNameSchema,
  emailSchema,
  isoDateTime,
} from './base.model';

/**
 * User entity.
 *
 * AUTHORISATION MODEL
 * ===================
 * `role` lives HERE, in our datastore — never in the identity provider's token. An
 * identity provider asserts *who* someone is; it has no business asserting what they may
 * do inside this platform. Practical consequences:
 *
 *  - A compromised or misconfigured IdP cannot mint an administrator.
 *  - A role change takes effect on the next session-token refresh (≤ 1 h) rather than
 *    waiting for the provider to propagate a custom claim.
 *  - The platform can be repointed at Entra ID or Okta without re-modelling permissions.
 *
 * `enabled` is a local kill switch. Disabling a user blocks them here immediately even if
 * they still hold a valid Firebase session, which matters during an offboarding or an
 * incident.
 */
export const UserSchema = z.object({
  ...auditableShape,

  /** Provider-scoped stable identifier (Firebase `uid`). Unique across the collection. */
  subject: z.string().min(1).max(128),
  email: emailSchema,
  emailVerified: z.boolean().default(false),
  displayName: displayNameSchema.optional(),
  photoUrl: z.string().url().max(2048).optional(),

  role: z.enum(USER_ROLES as [UserRole, ...UserRole[]]),
  enabled: z.boolean().default(true),

  /**
   * Departments this user may act on. An EMPTY array means unrestricted — administrators
   * and platform-wide managers. A non-empty array restricts mutations to those
   * departments and their slices, which is how a large enterprise delegates day-to-day
   * slice operations to a plant or regional team without granting global control.
   */
  departmentScope: z.array(z.string().min(1)).max(100).default([]),

  /** Provider used at last sign-in — `google.com`, `password`, `saml.*`. */
  signInProvider: z.string().min(1).max(64).optional(),
  lastLoginAt: isoDateTime.optional(),
  loginCount: z.number().int().nonnegative().default(0),

  /**
   * Sessions issued before this instant are rejected. Bumped when a role changes or an
   * administrator forces sign-out, so a privilege reduction cannot be outlived by an
   * already-issued access token.
   */
  sessionsValidFrom: isoDateTime.optional(),

  notificationPreferences: z
    .object({
      dashboard: z.boolean().default(true),
      email: z.boolean().default(false),
      /** Minimum severity that generates a notification for this user. */
      minimumSeverity: z.enum(['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL']).default('WARNING'),
    })
    .default({ dashboard: true, email: false, minimumSeverity: 'WARNING' }),
});

export type User = z.infer<typeof UserSchema>;

/* ------------------------------------------------------------------ */
/* API payloads                                                        */
/* ------------------------------------------------------------------ */

/**
 * Administrator-driven changes to another user. Deliberately narrow: identity fields
 * (`email`, `subject`) are owned by the identity provider and are not editable here,
 * because letting an admin rewrite an email would silently reassign an account.
 */
export const UpdateUserSchema = z
  .object({
    role: z.enum(USER_ROLES as [UserRole, ...UserRole[]]).optional(),
    enabled: z.boolean().optional(),
    displayName: displayNameSchema.optional(),
    departmentScope: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be supplied',
  });

export type UpdateUserPayload = z.infer<typeof UpdateUserSchema>;

/** Self-service preferences a user may change for their own account. */
export const UpdateOwnProfileSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    notificationPreferences: z
      .object({
        dashboard: z.boolean().optional(),
        email: z.boolean().optional(),
        minimumSeverity: z
          .enum(['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL'])
          .optional(),
      })
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be supplied',
  });

export type UpdateOwnProfilePayload = z.infer<typeof UpdateOwnProfileSchema>;

export const UserListQuerySchema = z.object({
  role: z.enum(USER_ROLES as [UserRole, ...UserRole[]]).optional(),
  enabled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  search: z.string().trim().max(120).optional(),
});

/* ------------------------------------------------------------------ */
/* Projections & helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Public representation of a user.
 *
 * `subject` is stripped: it is the provider's primary key, is useful for account takeover
 * reconnaissance, and the SPA has no legitimate use for it.
 */
export interface PublicUser {
  id: string;
  email: string;
  displayName?: string;
  photoUrl?: string;
  role: UserRole;
  enabled: boolean;
  departmentScope: string[];
  lastLoginAt?: string;
  loginCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.photoUrl ? { photoUrl: user.photoUrl } : {}),
    role: user.role,
    enabled: user.enabled,
    departmentScope: user.departmentScope,
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
    loginCount: user.loginCount,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** True when the user may act on the given department (empty scope = unrestricted). */
export function hasDepartmentAccess(user: Pick<User, 'departmentScope'>, departmentId: string): boolean {
  return user.departmentScope.length === 0 || user.departmentScope.includes(departmentId);
}
