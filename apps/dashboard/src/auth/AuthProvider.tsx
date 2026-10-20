import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, sessionStore, setSessionExpiredHandler } from '@/api/client';
import { authApi } from '@/api/resources';
import type { PublicUser, UserRole } from '@/types/api';

/**
 * Authentication context.
 *
 * Local/Role-based authentication context.
 */

export interface AuthState {
  user: PublicUser | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  error: string | null;

  signInGoogle: () => Promise<void>;
  signInEmail: (email: string, password?: string) => Promise<void>;
  signInDev: (email: string, displayName?: string) => Promise<void>;
  signOut: (everywhere?: boolean) => Promise<void>;
  clearError: () => void;

  /** True when the user's role is at or above `minimum`. */
  hasRole: (minimum: UserRole) => boolean;
  isAdmin: boolean;
  isManager: boolean;
}

const ROLE_RANK: Record<UserRole, number> = { VIEWER: 0, MANAGER: 1, ADMIN: 2 };

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [error, setError] = useState<string | null>(null);

  /* ---- Restore an existing session on mount -------------------------- */
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      if (!sessionStore.get()) {
        setStatus('unauthenticated');
        return;
      }

      try {
        const profile = await authApi.me();
        if (cancelled) return;
        setUser(profile);
        setStatus('authenticated');
      } catch {
        if (cancelled) return;
        sessionStore.clear();
        setStatus('unauthenticated');
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- React to an unrecoverable 401 from any request ---------------- */
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null);
      setStatus('unauthenticated');
      setError('Your session expired. Sign in again.');
    });
  }, []);

  /**
   * Role-based development sign-in.
   */
  const signInDev = useCallback(async (email: string, displayName?: string) => {
    setError(null);
    try {
      const { user: profile, session } = await authApi.devLogin(email, displayName);
      sessionStore.set(session);
      setUser(profile);
      setStatus('authenticated');
    } catch (err) {
      setError(describeError(err));
      throw err;
    }
  }, []);

  const signInGoogle = useCallback(async () => {
    return signInDev('admin@example.com', 'Administrator');
  }, [signInDev]);

  const signInEmail = useCallback(
    async (email: string, _password?: string) => {
      return signInDev(email);
    },
    [signInDev],
  );

  const signOut = useCallback(async (everywhere = false) => {
    await authApi.logout(everywhere).catch(() => undefined);
    sessionStore.clear();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      status,
      error,
      signInGoogle,
      signInEmail,
      signInDev,
      signOut,
      clearError: () => setError(null),
      hasRole: (minimum: UserRole) =>
        user !== null && ROLE_RANK[user.role] >= ROLE_RANK[minimum],
      isAdmin: user?.role === 'ADMIN',
      isManager: user !== null && ROLE_RANK[user.role] >= ROLE_RANK.MANAGER,
    }),
    [user, status, error, signInGoogle, signInEmail, signInDev, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an <AuthProvider>');
  }
  return context;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : 'Sign-in failed.';
}
