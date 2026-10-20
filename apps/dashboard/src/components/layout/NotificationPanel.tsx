import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { notificationsApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/cn';
import { formatRelative, statusStyles } from '@/lib/format';
import { Badge, Button, EmptyState, LoadingState } from '@/components/ui';
import { Icons } from './Icons';
import type { Notification, NotificationSeverity } from '@/types/api';

/**
 * Notification drawer.
 *
 * Reads the PERSISTED notifications rather than an in-memory list of socket frames. An
 * operator arriving at 06:00 must see what happened overnight; a drawer populated only by
 * live frames would be empty for them, which is precisely backwards.
 *
 * Socket frames prepend into the same React Query cache key, so live arrivals appear
 * instantly without a refetch.
 */
export function NotificationPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const queryClient = useQueryClient();

  const { data: notifications, isLoading } = useQuery({
    queryKey: queryKeys.notifications.list(),
    queryFn: () => notificationsApi.list({ limit: 50 }),
    refetchInterval: 30_000,
  });

  const markRead = useMutation({
    mutationFn: (ids: string[]) => notificationsApi.markRead(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() });
    },
  });

  const unreadIds = (notifications ?? []).filter((n) => !n.read).map((n) => n.id);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />

      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-edge bg-surface-raised shadow-2xl animate-slide-up">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-edge px-4">
          <h2 className="text-sm font-semibold text-content">Notifications</h2>
          <div className="flex items-center gap-2">
            {unreadIds.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                loading={markRead.isPending}
                onClick={() => markRead.mutate(unreadIds)}
              >
                Mark all read
              </Button>
            )}
            <button
              onClick={onClose}
              className="rounded p-1.5 text-content-muted hover:bg-surface-sunken hover:text-content"
              aria-label="Close notifications"
            >
              <Icons.close className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <LoadingState label="Loading notifications" />
          ) : !notifications || notifications.length === 0 ? (
            <EmptyState
              icon={<Icons.bell className="h-8 w-8" />}
              title="Nothing to report"
              description="Arbitration decisions, contention events and recoveries will appear here."
            />
          ) : (
            <ul className="divide-y divide-edge/60">
              {notifications.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onNavigate={onClose}
                  onMarkRead={() => markRead.mutate([notification.id])}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

function NotificationRow({
  notification,
  onNavigate,
  onMarkRead,
}: {
  notification: Notification;
  onNavigate: () => void;
  onMarkRead: () => void;
}) {
  const style = severityStyleOf(notification.severity);

  const body = (
    <div
      className={cn(
        'flex gap-3 px-4 py-3 transition-colors',
        !notification.read && 'bg-brand/[0.04]',
        notification.link && 'hover:bg-surface-sunken',
      )}
    >
      <div className={cn('mt-0.5 h-2 w-2 shrink-0 rounded-full', style.text.replace('text-', 'bg-'))} />

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium leading-snug text-content">{notification.title}</p>
          {!notification.read && (
            <button
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMarkRead();
              }}
              className="shrink-0 rounded p-0.5 text-content-subtle hover:text-content"
              aria-label="Mark as read"
            >
              <Icons.check className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <p className="mt-1 text-xs leading-relaxed text-content-muted">{notification.body}</p>

        <div className="mt-2 flex items-center gap-2">
          <Badge style={style} className="text-[10px]">
            {notification.severity}
          </Badge>
          <span className="text-[10px] text-content-subtle tabular">
            {formatRelative(notification.atMs)}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <li>
      {notification.link ? (
        <Link to={notification.link} onClick={onNavigate} className="block">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

function severityStyleOf(severity: NotificationSeverity) {
  switch (severity) {
    case 'CRITICAL':
    case 'ERROR':
      return statusStyles.critical;
    case 'WARNING':
      return statusStyles.warning;
    case 'SUCCESS':
      return statusStyles.healthy;
    default:
      return statusStyles.info;
  }
}
