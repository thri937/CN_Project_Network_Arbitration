import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { Button, Spinner } from '@/components/ui';

/** The three demo accounts the seed creates. Local sign-in: no passwords. */
const ACCOUNTS: { email: string; name: string; can: string }[] = [
  { email: 'admin@example.com', name: 'Admin', can: 'Everything, including the business policy, overrides and the audit log.' },
  { email: 'manager@example.com', name: 'Manager', can: 'Runs the testbed: scenarios, device demand, arbitration on/off.' },
  { email: 'viewer@example.com', name: 'Viewer', can: 'Watches only.' },
];

export function LoginPage(): JSX.Element {
  const { status, error, signInDev } = useAuth();
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  if (status === 'authenticated') return <Navigate to="/" replace />;
  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-surface">
        <Spinner className="h-6 w-6 text-brand" />
      </div>
    );
  }

  const signIn = async (email: string, displayName?: string) => {
    setBusy(email);
    try {
      await signInDev(email, displayName);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-surface px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-content">Slice Arbitration Testbed</h1>
        <p className="mt-1 text-sm text-content-muted">
          Computer Networks project: business-aware arbitration of enterprise network slices on a real 1 Mbps link.
        </p>

        {error && <p className="mt-4 rounded border border-critical/40 px-3 py-2 text-sm text-critical">{error}</p>}

        <div className="mt-6 space-y-2">
          {ACCOUNTS.map((a) => (
            <button
              key={a.email}
              type="button"
              disabled={busy !== null}
              onClick={() => void signIn(a.email, a.name)}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-edge bg-surface-raised px-4 py-3 text-left hover:border-brand/50 disabled:opacity-50"
            >
              <span>
                <span className="block text-sm font-medium text-content">Sign in as {a.name}</span>
                <span className="block text-xs text-content-muted">{a.can}</span>
              </span>
              {busy === a.email && <Spinner className="h-4 w-4 text-brand" />}
            </button>
          ))}
        </div>

        <form
          className="mt-6 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (other.trim()) void signIn(other.trim());
          }}
        >
          <label htmlFor="other-login" className="block text-xs text-content-muted">
            Or type a name or email (new accounts start as viewers)
          </label>
          <div className="flex gap-2">
            <input
              id="other-login"
              type="text"
              value={other}
              onChange={(e) => setOther(e.target.value)}
              placeholder="e.g. manager"
              className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content placeholder:text-content-subtle focus:border-brand focus:outline-none"
            />
            <Button type="submit" variant="secondary" loading={busy === other.trim()} disabled={!other.trim() || busy !== null}>
              Sign in
            </Button>
          </div>
        </form>

        <p className="mt-8 text-xs text-content-subtle">
          Local sign-in without passwords, for use on your own network only.
        </p>
      </div>
    </div>
  );
}
