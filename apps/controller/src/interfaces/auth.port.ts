import type { UserRole } from '@/constants/enums';

/**
 * PORT — Identity Provider
 *
 * Abstracts the external identity provider (Firebase Authentication in production, a local
 * signer in development). The application layer never imports `firebase-admin`; it depends
 * only on this interface.
 *
 * Rationale beyond testability: enterprises that deploy this platform on-premises
 * frequently mandate their own IdP (Azure AD / Entra, Okta, Keycloak). Implementing
 * `IAuthPort` is the entire integration surface for that.
 */

/** The identity as asserted by the external provider, before local authorisation. */
export interface ExternalIdentity {
  /** Provider-scoped stable subject identifier (Firebase `uid`). */
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  photoUrl?: string;
  /** e.g. `google.com`, `password`, `saml.corp`. */
  signInProvider: string;
  /** Epoch seconds. */
  issuedAt: number;
  expiresAt: number;
  /** Provider-side custom claims, if any. Never trusted for authorisation on its own. */
  claims?: Record<string, unknown>;
}

/**
 * The authenticated caller as this platform understands them, after the external identity
 * has been resolved against our own `users` collection. `role` comes from OUR datastore,
 * never from the provider token — an IdP compromise must not be able to mint an admin.
 */
export interface AuthenticatedPrincipal {
  userId: string;
  subject: string;
  email: string;
  role: UserRole;
  displayName?: string;
  /** Departments this principal may act on; empty means "all" (admins and managers). */
  departmentScope: string[];
  /** Epoch seconds, from the backend-issued session token. */
  issuedAt: number;
  expiresAt: number;
  sessionId: string;
}

export interface AuthProviderCapabilities {
  /** Whether the provider can enumerate and mutate users (Firebase can; a dev signer cannot). */
  userManagement: boolean;
  /** Whether refresh-token revocation is supported (forces sign-out on all devices). */
  revocation: boolean;
  passwordAuth: boolean;
  federatedAuth: boolean;
}

export interface IAuthPort {
  readonly name: string;

  /**
   * Verify a provider-issued ID token.
   * @throws {UnauthenticatedError} when the token is malformed, expired, or not ours.
   */
  verifyIdToken(idToken: string): Promise<ExternalIdentity>;

  capabilities(): AuthProviderCapabilities;

  /** Optional — present only when `capabilities().userManagement` is true. */
  getUserBySubject?(subject: string): Promise<ExternalIdentity | null>;
  getUserByEmail?(email: string): Promise<ExternalIdentity | null>;
  setEnabled?(subject: string, enabled: boolean): Promise<void>;
  revokeSessions?(subject: string): Promise<void>;

  /** Liveness probe for the health registry. */
  ping(): Promise<void>;
}
