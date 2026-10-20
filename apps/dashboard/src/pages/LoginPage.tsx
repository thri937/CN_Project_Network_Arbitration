import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { Button, Spinner } from '@/components/ui';
import { Icons } from '@/components/layout/Icons';

interface QuickUser {
  role: 'ADMIN' | 'MANAGER' | 'VIEWER';
  email: string;
  name: string;
  description: string;
  badgeClass: string;
}

const PRESET_USERS: QuickUser[] = [
  {
    role: 'ADMIN',
    email: 'admin@example.com',
    name: 'Administrator',
    description: 'Full control: governing policies, user management & overrides',
    badgeClass: 'bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400',
  },
  {
    role: 'MANAGER',
    email: 'manager@example.com',
    name: 'Network Manager',
    description: 'Operations: contention simulation, fault injection & slice controls',
    badgeClass: 'bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400',
  },
  {
    role: 'VIEWER',
    email: 'viewer@example.com',
    name: 'Operations Viewer',
    description: 'Read-only: live telemetry, network topology & contention history',
    badgeClass: 'bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400',
  },
];

export function LoginPage(): JSX.Element {
  const { status, error, signInDev } = useAuth();
  const [customEmail, setCustomEmail] = useState('');
  const [busyUser, setBusyUser] = useState<string | null>(null);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-surface">
        <Spinner className="h-6 w-6 text-brand" />
      </div>
    );
  }

  const handleLogin = async (email: string, displayName?: string) => {
    setBusyUser(email);
    try {
      await signInDev(email, displayName);
    } finally {
      setBusyUser(null);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-surface px-4 py-10">
      <div className="w-full max-w-md">
        {/* Brand Header */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand shadow-sm">
            <Icons.network className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-content">Network Arbitration Platform</h1>
          <p className="mt-1 text-sm text-content-muted">Enterprise Operations Centre</p>
        </div>

        <div className="card space-y-6 p-6 shadow-sm border border-edge">
          {error && (
            <div className="rounded-lg border border-critical/30 bg-critical/10 px-3.5 py-2.5">
              <p className="text-xs leading-relaxed text-critical font-medium">{error}</p>
            </div>
          )}

          {/* Quick 1-Click Role Login */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-content-muted">
              Select User Role
            </label>
            <p className="mt-0.5 text-xs text-content-subtle mb-3">
              One-click sign-in with preconfigured platform roles
            </p>

            <div className="space-y-2.5">
              {PRESET_USERS.map((preset) => {
                const isLoggingIn = busyUser === preset.email;
                return (
                  <button
                    key={preset.role}
                    type="button"
                    disabled={busyUser !== null}
                    onClick={() => void handleLogin(preset.email, preset.name)}
                    className="w-full text-left rounded-xl border border-edge hover:border-brand/40 bg-surface-raised hover:bg-surface-sunken p-3.5 transition-all duration-150 flex items-start justify-between gap-3 group disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-content group-hover:text-brand">
                          {preset.name}
                        </span>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${preset.badgeClass}`}
                        >
                          {preset.role}
                        </span>
                      </div>
                      <p className="text-xs text-content-muted leading-snug">
                        {preset.description}
                      </p>
                      <span className="text-[11px] font-mono text-content-subtle block">
                        {preset.email}
                      </span>
                    </div>

                    <div className="shrink-0 pt-1">
                      {isLoggingIn ? (
                        <Spinner className="h-4 w-4 text-brand" />
                      ) : (
                        <span className="text-xs font-medium text-brand opacity-0 group-hover:opacity-100 transition-opacity">
                          Sign in &rarr;
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-edge" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-surface px-2 text-content-subtle">Or custom login</span>
            </div>
          </div>

          {/* Custom Identifier Login */}
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (customEmail.trim()) {
                void handleLogin(customEmail.trim());
              }
            }}
          >
            <div>
              <label htmlFor="custom-login" className="block text-xs font-medium text-content mb-1">
                Email or Username
              </label>
              <input
                id="custom-login"
                type="text"
                value={customEmail}
                onChange={(e) => setCustomEmail(e.target.value)}
                placeholder="admin, manager, viewer, or email..."
                className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content placeholder:text-content-subtle focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>

            <Button
              variant="secondary"
              type="submit"
              className="w-full"
              loading={busyUser === customEmail}
              disabled={!customEmail.trim() || busyUser !== null}
            >
              Sign in with Custom Account
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs leading-relaxed text-content-subtle">
          Runtime Arbitration for Contended, SLA-Critical Enterprise Network Slices
        </p>
      </div>
    </div>
  );
}
