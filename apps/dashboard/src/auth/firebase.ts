/**
 * Authentication helper stubs (Firebase removed).
 *
 * Local/development authentication is used with predefined roles:
 * Viewer, Manager, and Admin.
 */

export function isFirebaseConfigured(): boolean {
  return false;
}

export async function signInWithGoogle(): Promise<string> {
  throw new Error('Firebase sign-in is disabled. Use role-based login.');
}

export async function signInWithEmail(_email: string, _password?: string): Promise<string> {
  throw new Error('Firebase sign-in is disabled. Use role-based login.');
}

export async function signOutFirebase(): Promise<void> {
  // No-op
}

export function describeFirebaseError(error: unknown): string {
  return error instanceof Error ? error.message : 'Sign-in failed.';
}
