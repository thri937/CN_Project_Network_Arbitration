import type { RequestHandler } from 'express';
import { ROLE_RANK, UserRole } from '@/constants/enums';
import { ForbiddenError, InsufficientRoleError } from '@/utils/errors';
import { requirePrincipal } from './authenticate';

/**
 * Role-based access control.
 *
 * ROLE SEMANTICS
 * ==============
 *   VIEWER   — read everything they are scoped to. Cannot change anything.
 *   MANAGER  — operate the network: create/update/pause/resume slices, edit departments
 *              and policies, trigger a manual arbitration. Cannot manage users or alter
 *              platform settings.
 *   ADMIN    — everything, including user management, settings, and overriding an
 *              arbitration decision.
 *
 * Roles are hierarchical (`ROLE_RANK`), so `requireMinRole(MANAGER)` admits administrators
 * without every route having to enumerate `[MANAGER, ADMIN]` — a pattern that reliably
 * rots the moment a fourth role is introduced.
 *
 * WHY THIS IS A SEPARATE MIDDLEWARE FROM `authenticate`
 * =====================================================
 * Authentication answers "who are you", authorisation answers "may you". Fusing them
 * produces routes where forgetting the role check still yields a working endpoint —
 * open to every signed-in user. Keeping them separate makes the omission visible in the
 * route definition, which is exactly where a reviewer looks.
 */

export function requireMinRole(minimum: UserRole): RequestHandler {
  const threshold = ROLE_RANK[minimum];

  return function authorize(req, _res, next) {
    try {
      const principal = requirePrincipal(req);
      if (ROLE_RANK[principal.role] < threshold) {
        throw new InsufficientRoleError(minimum, principal.role);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Admits only the listed roles. Use when the permission is not hierarchical. */
export function requireRole(...allowed: UserRole[]): RequestHandler {
  return function authorize(req, _res, next) {
    try {
      const principal = requirePrincipal(req);
      if (!allowed.includes(principal.role)) {
        throw new InsufficientRoleError(allowed.join(' or '), principal.role);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireAdmin = requireMinRole(UserRole.ADMIN);
export const requireManager = requireMinRole(UserRole.MANAGER);
export const requireViewer = requireMinRole(UserRole.VIEWER);

/**
 * Admits the resource owner, or anyone holding at least `fallbackRole`.
 *
 * Used for `/users/:id` endpoints, where a user may read and edit their own profile while
 * only administrators may touch anyone else's.
 */
export function requireSelfOrRole(paramName: string, fallbackRole: UserRole): RequestHandler {
  const threshold = ROLE_RANK[fallbackRole];

  return function authorize(req, _res, next) {
    try {
      const principal = requirePrincipal(req);
      const targetId = req.params[paramName];

      if (targetId && targetId === principal.userId) return next();
      if (ROLE_RANK[principal.role] >= threshold) return next();

      throw new ForbiddenError('You may only access your own account');
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Restricts a route to callers scoped to the department named by a path or query
 * parameter. Unscoped principals (empty `departmentScope`) pass.
 */
export function requireDepartmentScope(paramName = 'departmentId'): RequestHandler {
  return function authorize(req, _res, next) {
    try {
      const principal = requirePrincipal(req);
      if (principal.departmentScope.length === 0) return next();

      const departmentId =
        (req.params[paramName] as string | undefined) ??
        (typeof req.query[paramName] === 'string' ? (req.query[paramName] as string) : undefined);

      // No department in the request means the handler filters by scope itself; the
      // middleware cannot make a decision and must not invent one.
      if (!departmentId) return next();

      if (!principal.departmentScope.includes(departmentId)) {
        throw new ForbiddenError('You do not have access to this department', { departmentId });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
