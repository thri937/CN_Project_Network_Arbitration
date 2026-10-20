import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { auditApi } from '@/api/resources';
import { queryKeys } from '@/lib/queryKeys';
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
} from '@/components/ui';
import { Icons } from '@/components/layout/Icons';
import { cn } from '@/lib/cn';
import { formatDateTime, humanise, statusStyles } from '@/lib/format';

/**
 * Audit log.
 *
 * READ-ONLY BY CONSTRUCTION — there is no mutation control on this page because there is no
 * mutating endpoint behind it, not even for an administrator. An audit trail that can be
 * edited by the people it holds to account is not an audit trail.
 *
 * The actor is shown as recorded at the time, not resolved from the current user directory:
 * the record must stay truthful after a rename, a role change, or a deletion.
 */
export function AuditPage(): JSX.Element {
  const [action, setAction] = useState<string>('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.audit.list({ action }),
    queryFn: () => auditApi.list({ limit: 100, ...(action ? { action } : {}) }),
    refetchInterval: 30_000,
  });

  if (isLoading) return <LoadingState label="Loading audit trail" />;

  const actions = [
    '',
    'ARBITRATION_EXECUTED',
    'ARBITRATION_OVERRIDDEN',
    'CONTENTION_DETECTED',
    'RECOVERY_COMPLETED',
    'ALLOCATION_ROLLED_BACK',
    'SLICE_CREATED',
    'SLICE_PAUSED',
    'DEPARTMENT_UPDATED',
    'POLICY_ACTIVATED',
    'USER_ROLE_CHANGED',
    'SETTINGS_UPDATED',
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Every decision, override and setting change, in order. Entries cannot be edited or deleted."
      />

      <div className="flex flex-wrap gap-1.5">
        {actions.map((value) => (
          <button
            key={value || 'all'}
            onClick={() => setAction(value)}
            className={
              action === value
                ? 'rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-white'
                : 'rounded-md border border-edge px-2.5 py-1 text-xs text-content-muted transition-colors hover:border-edge-strong hover:text-content'
            }
          >
            {value ? humanise(value) : 'All actions'}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Entries"
          subtitle={data ? `${data.items.length} shown` : undefined}
        />

        {!data || data.items.length === 0 ? (
          <EmptyState
            icon={<Icons.audit className="h-8 w-8" />}
            title="No audit entries"
            description="Actions taken through the platform will be recorded here."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th>Summary</Th>
                <Th>Target</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((entry) => (
                <Fragment key={entry.id}>
                  <tr
                    onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    className={cn(
                      'cursor-pointer transition-colors hover:bg-surface-sunken',
                      expanded === entry.id && 'bg-surface-sunken',
                    )}
                  >
                    <Td className="whitespace-nowrap text-content-muted">
                      {formatDateTime(entry.occurredAt)}
                    </Td>
                    <Td>
                      <Badge
                        style={
                          entry.outcome === 'SUCCESS'
                            ? statusStyles.neutral
                            : entry.outcome === 'DENIED'
                              ? statusStyles.warning
                              : statusStyles.critical
                        }
                        className="text-[10px]"
                      >
                        {humanise(entry.action)}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="text-xs">{entry.actor.email}</div>
                      <div className="text-[10px] text-content-subtle">{entry.actor.role}</div>
                    </Td>
                    <Td className="max-w-md">
                      <span className="line-clamp-2 text-xs">{entry.summary}</span>
                    </Td>
                    <Td className="text-content-muted">
                      {entry.target ? (
                        <span className="text-xs">
                          {entry.target.type}
                          <span className="block font-mono text-[10px] text-content-subtle">
                            {entry.target.name ?? entry.target.id}
                          </span>
                        </span>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td align="right">
                      <Icons.chevronRight
                        className={cn(
                          'h-4 w-4 text-content-subtle transition-transform',
                          expanded === entry.id && 'rotate-90',
                        )}
                      />
                    </Td>
                  </tr>

                  {expanded === entry.id && (
                    <tr key={`${entry.id}-detail`}>
                      <td colSpan={6} className="border-b border-edge bg-surface-sunken px-4 py-4">
                        <div className="grid gap-4 lg:grid-cols-2">
                          <div>
                            <div className="label mb-1.5">Context</div>
                            <dl className="space-y-1 text-[11px]">
                              <Row label="Correlation id" value={entry.correlationId} mono />
                              <Row label="Sequence" value={String(entry.sequence)} />
                              {entry.actor.ip && <Row label="Source IP" value={entry.actor.ip} mono />}
                              {entry.target?.departmentId && (
                                <Row label="Department" value={entry.target.departmentId} mono />
                              )}
                            </dl>
                          </div>

                          {entry.changes && entry.changes.length > 0 && (
                            <div>
                              <div className="label mb-1.5">Changes</div>
                              <ul className="space-y-1 text-[11px]">
                                {entry.changes.map((change) => (
                                  <li key={change.field} className="flex gap-2">
                                    <span className="w-32 shrink-0 truncate text-content-subtle">
                                      {change.field}
                                    </span>
                                    <span className="text-content-muted line-through">
                                      {formatValue(change.before)}
                                    </span>
                                    <span className="text-content-subtle">→</span>
                                    <span className="text-content">{formatValue(change.after)}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>

                        {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                          <div className="mt-4">
                            <div className="label mb-1.5">Metadata</div>
                            <pre className="overflow-x-auto rounded-lg border border-edge bg-surface-raised p-3 font-mono text-[10px] leading-relaxed text-content-muted">
                              {JSON.stringify(entry.metadata, null, 2)}
                            </pre>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-content-subtle">{label}</dt>
      <dd className={cn('truncate text-content', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
