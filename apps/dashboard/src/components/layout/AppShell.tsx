import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { useRealtime } from '@/realtime/RealtimeProvider';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/cn';
import { capacityLevelStyle, formatBandwidth, formatRelative } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { capacityApi, contentionApi, notificationsApi } from '@/api/resources';
import { Badge, Tooltip } from '@/components/ui';
import { Icons } from './Icons';
import { NotificationPanel } from './NotificationPanel';
import type { UserRole } from '@/types/api';

/**
 * Application shell.
 *
 * The persistent frame around every page: navigation, and a status strip that is ALWAYS
 * visible regardless of which page is open.
 *
 * That strip is the single most important piece of UI in the product. An operator may be
 * editing a department when the network goes into contention; if the only indication were
 * on the dashboard they would not see it. So capacity level, open contention and realtime
 * connectivity live in the top bar and follow the user everywhere.
 */

interface NavItem {
  to: string;
  label: string;
  icon: (props: { className?: string }) => JSX.Element;
  minRole?: UserRole;
  /** Renders a live count or status dot beside the label. */
  indicator?: 'contention';
  external?: boolean;
}

const NAV_SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Real 5G Testbed',
    items: [
      { to: '/', label: '5G Slice Testbed', icon: Icons.network },
      { to: '/slices', label: 'Slice Contracts & Floors', icon: Icons.slices },
      { to: '/monitoring', label: 'Runtime Monitoring', icon: Icons.monitoring },
      { to: '/contention', label: 'Contention Events', icon: Icons.contention, indicator: 'contention' },
      { to: '/arbitration', label: 'Arbitration Decisions', icon: Icons.arbitration },
    ],
  },
  {
    heading: 'Client Devices',
    items: [
      { to: 'http://localhost:5174', label: 'Client Slice Portal ↗', icon: Icons.network, external: true },
    ],
  },
];

export function AppShell(): JSX.Element {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="min-h-screen bg-surface">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="lg:pl-60">
        <TopBar
          onOpenSidebar={() => setSidebarOpen(true)}
          onToggleNotifications={() => setNotificationsOpen((v) => !v)}
          notificationsOpen={notificationsOpen}
        />

        <main className="px-4 py-6 sm:px-6 lg:px-8">
          {/* `key` on the route forces a remount between pages, so a page never renders
              with the previous page's stale local state during the transition. */}
          <div key={location.pathname} className="animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>

      {notificationsOpen && <NotificationPanel onClose={() => setNotificationsOpen(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, hasRole, signOut } = useAuth();

  const { data: contention } = useQuery({
    queryKey: queryKeys.contention.current(),
    queryFn: contentionApi.current,
    refetchInterval: 5000,
  });

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-60 border-r border-edge bg-surface-raised flex flex-col',
          'transition-transform duration-200 lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Brand */}
        <div className="flex h-14 items-center gap-2.5 border-b border-edge px-4">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand/15 text-brand">
            <Icons.network className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight text-content">5G Slice Testbed</div>
            <div className="text-[10px] uppercase tracking-wider text-content-subtle">
              Real-Network Arbitration
            </div>
          </div>
          <button
            className="ml-auto text-content-muted lg:hidden"
            onClick={onClose}
            aria-label="Close navigation"
          >
            <Icons.close className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {NAV_SECTIONS.map((section) => {
            const visible = section.items.filter((item) => !item.minRole || hasRole(item.minRole));
            if (visible.length === 0) return null;

            return (
              <div key={section.heading} className="mb-5">
                <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                  {section.heading}
                </div>
                <ul className="space-y-0.5">
                  {visible.map((item) => (
                    <li key={item.to}>
                      {item.external ? (
                        <a
                          href={item.to}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-cyan-400 hover:bg-surface-sunken hover:text-cyan-300 transition-colors font-medium"
                        >
                          <item.icon className="h-[18px] w-[18px] shrink-0" />
                          <span className="truncate">{item.label}</span>
                        </a>
                      ) : (
                        <NavLink
                          to={item.to}
                          end={item.to === '/'}
                          onClick={onClose}
                          className={({ isActive }) =>
                            cn(
                              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                              isActive
                                ? 'bg-brand/12 font-medium text-brand'
                                : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                            )
                          }
                        >
                          <item.icon className="h-[18px] w-[18px] shrink-0" />
                          <span className="truncate">{item.label}</span>

                          {item.indicator === 'contention' && contention?.open && (
                            <span className="ml-auto flex h-2 w-2 shrink-0">
                              <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-critical opacity-70" />
                              <span className="relative inline-flex h-2 w-2 rounded-full bg-critical" />
                            </span>
                          )}
                        </NavLink>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        {/* Identity */}
        <div className="border-t border-edge p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand/15 text-xs font-semibold text-brand">
              {initials(user?.displayName ?? user?.email ?? '?')}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-content">
                {user?.displayName ?? user?.email}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-content-subtle">
                {user?.role}
              </div>
            </div>
            <Tooltip content="Sign out">
              <button
                onClick={() => void signOut()}
                className="rounded p-1.5 text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content"
                aria-label="Sign out"
              >
                <Icons.logout className="h-4 w-4" />
              </button>
            </Tooltip>
          </div>
        </div>
      </aside>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Top bar                                                             */
/* ------------------------------------------------------------------ */

function TopBar({
  onOpenSidebar,
  onToggleNotifications,
  notificationsOpen,
}: {
  onOpenSidebar: () => void;
  onToggleNotifications: () => void;
  notificationsOpen: boolean;
}) {
  const { connected } = useRealtime();
  const { resolved, toggle } = useTheme();

  const { data: capacity } = useQuery({
    queryKey: queryKeys.capacity.current(),
    queryFn: capacityApi.current,
    // Polling is the FALLBACK. When the socket is connected it writes the same cache key
    // far more often, and this interval effectively becomes a liveness backstop.
    refetchInterval: connected ? 15_000 : 3000,
  });

  const { data: unread } = useQuery({
    queryKey: queryKeys.notifications.unreadCount(),
    queryFn: notificationsApi.unreadCount,
    refetchInterval: 20_000,
  });

  const state = capacity?.capacity ?? null;
  const levelStyle = state ? capacityLevelStyle(state.level) : null;

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-edge bg-surface-raised/95 px-4 backdrop-blur sm:px-6 lg:px-8">
      <button
        className="text-content-muted lg:hidden"
        onClick={onOpenSidebar}
        aria-label="Open navigation"
      >
        <Icons.menu className="h-5 w-5" />
      </button>

      {/* THE STATUS STRIP — visible on every page, by design. */}
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto">
        {state && levelStyle && (
          <Tooltip
            content={
              <>
                <strong>Demand ratio</strong> is demand ÷ offered capacity. It can exceed
                100 %, which is what makes it the contention signal — utilisation saturates at
                100 % and cannot distinguish "full" from "badly oversubscribed".
              </>
            }
          >
            <Badge style={levelStyle} dot pulse={state.oversubscribed}>
              {state.level.replace('_', ' ')}
              <span className="ml-1 tabular opacity-80">
                {(state.demandRatio * 100).toFixed(0)}%
              </span>
            </Badge>
          </Tooltip>
        )}

        {state && (
          <div className="hidden items-center gap-3 text-xs text-content-muted sm:flex">
            <span className="tabular">
              <span className="text-content-subtle">demand</span>{' '}
              {formatBandwidth(state.demandMbps)}
            </span>
            <span className="text-content-subtle">/</span>
            <span className="tabular">
              <span className="text-content-subtle">capacity</span>{' '}
              {formatBandwidth(state.offeredCapacityMbps)}
            </span>
            {state.degradedSliceCount > 0 && (
              <Badge style={capacityLevelStyle('OVERSUBSCRIBED')}>
                {state.degradedSliceCount} degraded
              </Badge>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* Realtime status. Shown always, not only on failure: an operator must be able to
            tell "nothing is happening" from "I am not receiving updates". */}
        <Tooltip
          content={
            connected
              ? 'Live updates are streaming. The dashboard shows the same snapshot the arbitration engine is acting on.'
              : 'Realtime connection unavailable — falling back to polling. Data may lag by a few seconds.'
          }
        >
          <span className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-content-muted">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                connected ? 'bg-healthy' : 'bg-warning animate-pulse',
              )}
            />
            <span className="hidden sm:inline">{connected ? 'Live' : 'Polling'}</span>
          </span>
        </Tooltip>

        {state && (
          <span className="hidden text-[10px] text-content-subtle md:inline tabular">
            {formatRelative(state.atMs)}
          </span>
        )}

        <button
          onClick={onToggleNotifications}
          className={cn(
            'relative rounded-lg p-2 transition-colors',
            notificationsOpen
              ? 'bg-surface-sunken text-content'
              : 'text-content-muted hover:bg-surface-sunken hover:text-content',
          )}
          aria-label="Notifications"
        >
          <Icons.bell className="h-[18px] w-[18px]" />
          {(unread?.count ?? 0) > 0 && (
            <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-critical px-1 text-[10px] font-semibold text-white">
              {unread!.count > 99 ? '99+' : unread!.count}
            </span>
          )}
        </button>

        <button
          onClick={toggle}
          className="rounded-lg p-2 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
          aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`}
        >
          {resolved === 'dark' ? (
            <Icons.sun className="h-[18px] w-[18px]" />
          ) : (
            <Icons.moon className="h-[18px] w-[18px]" />
          )}
        </button>
      </div>
    </header>
  );
}

function initials(value: string): string {
  const parts = value.split(/[\s@._-]+/).filter(Boolean);
  return (parts[0]?.[0] ?? '?').toUpperCase() + (parts[1]?.[0] ?? '').toUpperCase();
}

export function RoleGate({
  minimum,
  children,
  fallback,
}: {
  minimum: UserRole;
  children: ReactNode;
  fallback?: ReactNode;
}): JSX.Element {
  const { hasRole } = useAuth();
  return <>{hasRole(minimum) ? children : (fallback ?? null)}</>;
}
