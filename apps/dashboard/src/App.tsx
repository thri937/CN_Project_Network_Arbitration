import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { AppShell } from '@/components/layout/AppShell';
import { LoadingState, EmptyState, Button } from '@/components/ui';
import { Icons } from '@/components/layout/Icons';
import { LoginPage } from '@/pages/LoginPage';
import type { UserRole } from '@/types/api';

/**
 * Routing.
 *
 * The landing page is the testbed (slices, devices, QR codes, scenarios). Every page is lazily
 * loaded.
 *
 * Role guards render an explicit "insufficient permission" page rather than redirecting.
 * A silent redirect leaves a manager wondering whether the audit log exists at all; naming
 * the required role tells them exactly what to ask for.
 */

const TestbedPage = lazy(() =>
  import('@/pages/TestbedPage').then((m) => ({ default: m.TestbedPage })),
);
const MonitoringPage = lazy(() =>
  import('@/pages/MonitoringPage').then((m) => ({ default: m.MonitoringPage })),
);
const SlicesPage = lazy(() => import('@/pages/SlicesPage').then((m) => ({ default: m.SlicesPage })));
const DepartmentsPage = lazy(() =>
  import('@/pages/DepartmentsPage').then((m) => ({ default: m.DepartmentsPage })),
);
const PoliciesPage = lazy(() =>
  import('@/pages/PoliciesPage').then((m) => ({ default: m.PoliciesPage })),
);
const ContentionPage = lazy(() =>
  import('@/pages/ContentionPage').then((m) => ({ default: m.ContentionPage })),
);
const ArbitrationPage = lazy(() =>
  import('@/pages/ArbitrationPage').then((m) => ({ default: m.ArbitrationPage })),
);
const DecisionDetailPage = lazy(() =>
  import('@/pages/DecisionDetailPage').then((m) => ({ default: m.DecisionDetailPage })),
);
const AuditPage = lazy(() => import('@/pages/AuditPage').then((m) => ({ default: m.AuditPage })));

export function App(): JSX.Element {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-surface">
        <LoadingState label="Restoring session" />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />

      <Route element={<AppShell />}>
        <Route
          index
          element={
            <Suspense fallback={<LoadingState />}>
              <TestbedPage />
            </Suspense>
          }
        />

        <Route path="testbed" element={<Navigate to="/" replace />} />
        <Route path="monitoring" element={<Lazy><MonitoringPage /></Lazy>} />
        <Route path="slices" element={<Lazy><SlicesPage /></Lazy>} />
        <Route path="departments" element={<Lazy><DepartmentsPage /></Lazy>} />
        <Route path="policies" element={<Lazy><PoliciesPage /></Lazy>} />
        <Route path="contention" element={<Lazy><ContentionPage /></Lazy>} />
        <Route path="arbitration" element={<Lazy><ArbitrationPage /></Lazy>} />
        <Route path="arbitration/:id" element={<Lazy><DecisionDetailPage /></Lazy>} />

        <Route
          path="audit"
          element={
            <RequireRole minimum="ADMIN">
              <Lazy>
                <AuditPage />
              </Lazy>
            </RequireRole>
          }
        />

        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function Lazy({ children }: { children: React.ReactNode }): JSX.Element {
  return <Suspense fallback={<LoadingState />}>{children}</Suspense>;
}

/**
 * Role guard.
 *
 * Names the required role instead of redirecting silently. This is a defence-in-depth
 * measure only — the API enforces the same rule, and hiding a route in the SPA protects
 * nothing on its own.
 */
function RequireRole({
  minimum,
  children,
}: {
  minimum: UserRole;
  children: React.ReactNode;
}): JSX.Element {
  const { hasRole, user } = useAuth();

  if (hasRole(minimum)) return <>{children}</>;

  return (
    <EmptyState
      icon={<Icons.shield className="h-10 w-10" />}
      title={`This page requires the ${minimum} role`}
      description={`Your account currently has the ${user?.role} role. Ask an administrator if you need access.`}
      action={
        <Button size="sm" onClick={() => window.history.back()}>
          Go back
        </Button>
      }
    />
  );
}

function NotFound(): JSX.Element {
  return (
    <EmptyState
      title="Page not found"
      description="The page you are looking for does not exist."
      action={
        <Button size="sm" onClick={() => window.location.assign('/')}>
          Back to dashboard
        </Button>
      }
    />
  );
}
