import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usersApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/auth/AuthProvider';
import { ApiError } from '@/api/client';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  LoadingState,
  PageHeader,
  Table,
  Td,
  Th,
  Tooltip,
} from '@/components/ui';
import { Icons } from '@/components/layout/Icons';
import { formatDateTime, formatRelative, statusStyles } from '@/lib/format';
import type { UserRole } from '@/types/api';

/**
 * User management.
 *
 * Role changes take effect immediately: the backend advances the user's session watermark,
 * which invalidates every token they already hold. That is stated on the page, because an
 * administrator demoting someone mid-incident needs to know whether it is instant or takes
 * an hour.
 *
 * The self-change guard is enforced server-side; the UI mirrors it so the control is not
 * offered rather than offered and rejected.
 */
export function UsersPage(): JSX.Element {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.users.list(),
    queryFn: () => usersApi.list({ limit: 100 }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.users.all() });
  };

  const updateRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) => usersApi.update(id, { role }),
    onSuccess: invalidate,
  });

  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      usersApi.update(id, { enabled }),
    onSuccess: invalidate,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => usersApi.revokeSessions(id),
    onSuccess: invalidate,
  });

  if (isLoading) return <LoadingState label="Loading users" />;

  const error = [updateRole.error, setEnabled.error, revoke.error].find(
    (e): e is ApiError => e instanceof ApiError,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="User Management"
        description="Roles are held in this platform's datastore, never in the identity provider — so a compromised IdP cannot mint an administrator."
      />

      {error && (
        <div className="rounded-lg border border-critical/30 bg-critical/10 px-4 py-3">
          <p className="text-xs text-critical">{error.message}</p>
        </div>
      )}

      <Card>
        <CardHeader
          title="Users"
          subtitle="A role change invalidates that user's existing sessions immediately"
        />

        {!data || data.items.length === 0 ? (
          <EmptyState icon={<Icons.users className="h-8 w-8" />} title="No users" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>User</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th align="right">Sign-ins</Th>
                <Th>Last seen</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((user) => {
                const isSelf = user.id === currentUser?.id;

                return (
                  <tr key={user.id} className="transition-colors hover:bg-surface-sunken">
                    <Td>
                      <div className="font-medium">{user.displayName ?? user.email}</div>
                      {user.displayName && (
                        <div className="text-[10px] text-content-subtle">{user.email}</div>
                      )}
                    </Td>

                    <Td>
                      {isSelf ? (
                        <Tooltip content="You cannot change your own role. Another administrator must do it, which keeps the action attributable and prevents accidental loss of access.">
                          <Badge style={statusStyles.info} className="cursor-help text-[10px]">
                            {user.role} (you)
                          </Badge>
                        </Tooltip>
                      ) : (
                        <select
                          value={user.role}
                          disabled={updateRole.isPending}
                          onChange={(event) =>
                            updateRole.mutate({
                              id: user.id,
                              role: event.target.value as UserRole,
                            })
                          }
                          className="rounded-md border border-edge-strong bg-surface px-2 py-1 text-xs text-content focus:border-brand focus:outline-none"
                        >
                          <option value="VIEWER">VIEWER</option>
                          <option value="MANAGER">MANAGER</option>
                          <option value="ADMIN">ADMIN</option>
                        </select>
                      )}
                    </Td>

                    <Td>
                      <Badge
                        style={user.enabled ? statusStyles.healthy : statusStyles.critical}
                        dot
                        className="text-[10px]"
                      >
                        {user.enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </Td>

                    <Td align="right">{user.loginCount}</Td>

                    <Td className="text-content-muted">
                      {user.lastLoginAt ? (
                        <Tooltip content={formatDateTime(user.lastLoginAt)}>
                          <span className="cursor-help text-xs">
                            {formatRelative(user.lastLoginAt)}
                          </span>
                        </Tooltip>
                      ) : (
                        '—'
                      )}
                    </Td>

                    <Td align="right">
                      {!isSelf && (
                        <div className="flex items-center justify-end gap-1">
                          <Tooltip content="Force sign-out on every device by advancing the session watermark.">
                            <button
                              onClick={() => revoke.mutate(user.id)}
                              disabled={revoke.isPending}
                              className="rounded p-1.5 text-content-muted hover:bg-surface-raised hover:text-warning"
                              aria-label={`Revoke sessions for ${user.email}`}
                            >
                              <Icons.refresh className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>

                          <Tooltip content={user.enabled ? 'Disable this account' : 'Enable this account'}>
                            <button
                              onClick={() =>
                                setEnabled.mutate({ id: user.id, enabled: !user.enabled })
                              }
                              disabled={setEnabled.isPending}
                              className="rounded p-1.5 text-content-muted hover:bg-surface-raised hover:text-critical"
                              aria-label={`${user.enabled ? 'Disable' : 'Enable'} ${user.email}`}
                            >
                              {user.enabled ? (
                                <Icons.close className="h-3.5 w-3.5" />
                              ) : (
                                <Icons.check className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Role capabilities" />
        <Table>
          <thead>
            <tr>
              <Th>Role</Th>
              <Th>Can do</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>
                <Badge style={statusStyles.neutral} className="text-[10px]">
                  VIEWER
                </Badge>
              </Td>
              <Td className="text-xs text-content-muted">
                Read everything they are scoped to, including the full justification for any
                arbitration decision. Change nothing.
              </Td>
            </tr>
            <tr>
              <Td>
                <Badge style={statusStyles.info} className="text-[10px]">
                  MANAGER
                </Badge>
              </Td>
              <Td className="text-xs text-content-muted">
                Operate the network: create and edit slices and departments, pause and resume
                slices, simulate and trigger arbitration, inject synthetic load.
              </Td>
            </tr>
            <tr>
              <Td>
                <Badge style={statusStyles.critical} className="text-[10px]">
                  ADMIN
                </Badge>
              </Td>
              <Td className="text-xs text-content-muted">
                Everything, plus user management, business-policy changes, platform settings,
                deleting departments and slices, and overriding an arbitration decision.
              </Td>
            </tr>
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
