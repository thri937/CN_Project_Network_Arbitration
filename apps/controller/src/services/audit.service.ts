import { Collections } from '@/constants/collections';
import type { AuditAction } from '@/constants/enums';
import type { IDatastore, IRepository, TransactionContext } from '@/interfaces/repository.port';
import type { IClock } from '@/interfaces/clock.port';
import {
  AuditOutcome,
  type ArbitrationAuditDetail,
  type AuditLog,
  type AuditLogQuery,
} from '@/models/auditLog.model';
import type { ActorContext, Page, QueryFilter } from '@/types/common';
import { createLogger } from '@/utils/logger';

const log = createLogger('audit');

/**
 * Audit logger.
 *
 * Every consequential state change in the platform passes through `record()`.
 *
 * FAILURE POLICY — the one genuinely contentious decision here
 * ============================================================
 * When an audit write fails, we log the failure loudly and let the originating operation
 * SUCCEED. The alternative — failing the business operation because its audit record could
 * not be written — was considered and rejected:
 *
 *   This platform degrades network slices during capacity contention. If a transient
 *   Firestore outage blocked arbitration from executing, the network would stay overloaded
 *   and every slice would suffer, in order to protect a log entry. Availability of the
 *   control loop outweighs completeness of the trail.
 *
 * The mitigation is that the failure is unmissable: logged at `error` with the full record
 * payload, so the entry is recoverable from application logs, and surfaced through the
 * `audit-writer` health probe, which degrades the service when writes are failing.
 *
 * The exception is `recordInTransaction()`: when an audit record is enlisted in the same
 * transaction as the change it describes, they commit or fail together. Module 9 uses this
 * for arbitration decisions, where a degraded slice with no audit record would be exactly
 * the failure mode the platform exists to prevent.
 */
export class AuditService {
  private readonly repo: IRepository<AuditLog>;
  private consecutiveFailures = 0;
  /** Monotonic tiebreaker for entries sharing a millisecond. See `AuditLogSchema`. */
  private sequence = 0;

  constructor(
    datastore: IDatastore,
    private readonly clock: IClock,
  ) {
    this.repo = datastore.repository<AuditLog>(Collections.AUDIT_LOGS);
  }

  /**
   * Append an audit entry. Never throws — see the failure policy above.
   * @returns the entry id, or null if the write failed.
   */
  async record(input: RecordAuditInput): Promise<string | null> {
    try {
      const entry = await this.repo.create(this.buildEntry(input));
      this.consecutiveFailures = 0;
      return entry.id;
    } catch (error) {
      this.consecutiveFailures += 1;
      log.error(
        { err: error, action: input.action, actor: input.actor.userId, entry: input },
        'AUDIT WRITE FAILED — entry preserved in this log line only',
      );
      return null;
    }
  }

  /**
   * Append an audit entry inside a caller-supplied transaction, so the record and the
   * change it describes commit atomically. Throws on failure, by design.
   *
   * Must be called AFTER all reads in the transaction — see the `IDatastore` contract.
   */
  async recordInTransaction(input: RecordAuditInput, tx: TransactionContext): Promise<string> {
    const entry = await this.repo.create(this.buildEntry(input), { tx });
    return entry.id;
  }

  /** Paginated audit query with the filters an investigator actually needs. */
  async query(query: AuditLogQuery, page: { limit: number; cursor?: string }): Promise<Page<AuditLog>> {
    const filters: QueryFilter[] = [];

    if (query.action) filters.push({ field: 'action', op: '==', value: query.action });
    if (query.outcome) filters.push({ field: 'outcome', op: '==', value: query.outcome });
    if (query.actorId) filters.push({ field: 'actor.userId', op: '==', value: query.actorId });
    if (query.targetId) filters.push({ field: 'target.id', op: '==', value: query.targetId });
    if (query.targetType) filters.push({ field: 'target.type', op: '==', value: query.targetType });
    if (query.contentionId) {
      filters.push({ field: 'arbitration.contentionId', op: '==', value: query.contentionId });
    }
    // Range filters use the epoch-ms mirror: numeric comparison needs no string parsing and
    // is index-friendly in both drivers.
    if (query.from) filters.push({ field: 'occurredAtMs', op: '>=', value: Date.parse(query.from) });
    if (query.to) filters.push({ field: 'occurredAtMs', op: '<=', value: Date.parse(query.to) });

    return this.repo.paginate({
      limit: page.limit,
      cursor: page.cursor,
      filters,
      orderBy: [{ field: 'occurredAtMs', direction: 'desc' }],
    });
  }

  async findById(id: string): Promise<AuditLog | null> {
    return this.repo.findById(id);
  }

  /** Full history for one target, oldest first — the timeline shown in the UI. */
  async timelineFor(targetId: string, limit = 100): Promise<AuditLog[]> {
    return this.repo.findMany({
      filters: [{ field: 'target.id', op: '==', value: targetId }],
      // `sequence` breaks ties within a millisecond so the timeline never reorders events.
      orderBy: [
        { field: 'occurredAtMs', direction: 'asc' },
        { field: 'sequence', direction: 'asc' },
      ],
      limit,
    });
  }

  /** Health probe: degrades the service when audit writes are repeatedly failing. */
  healthProbe = (): { status: 'up' | 'degraded'; message?: string } => {
    if (this.consecutiveFailures === 0) return { status: 'up' };
    return {
      status: 'degraded',
      message: `${this.consecutiveFailures} consecutive audit write failures — the audit trail is incomplete`,
    };
  };

  private buildEntry(input: RecordAuditInput): Omit<AuditLog, 'id' | 'createdAt' | 'updatedAt' | 'version'> {
    const now = this.clock.now();
    this.sequence += 1;

    return {
      action: input.action,
      outcome: input.outcome ?? AuditOutcome.SUCCESS,
      occurredAt: new Date(now).toISOString(),
      occurredAtMs: now,
      sequence: this.sequence,
      actor: {
        userId: input.actor.userId,
        email: input.actor.email,
        role: input.actor.role,
        ...(input.actor.displayName ? { displayName: input.actor.displayName } : {}),
        ...(input.actor.ip ? { ip: input.actor.ip } : {}),
        ...(input.actor.userAgent ? { userAgent: input.actor.userAgent.slice(0, 512) } : {}),
      },
      ...(input.target ? { target: input.target } : {}),
      summary: input.summary.slice(0, 500),
      ...(input.changes && input.changes.length > 0 ? { changes: input.changes.slice(0, 100) } : {}),
      ...(input.arbitration ? { arbitration: input.arbitration } : {}),
      correlationId: input.actor.correlationId,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }
}

export interface RecordAuditInput {
  action: AuditAction;
  actor: ActorContext;
  summary: string;
  outcome?: AuditOutcome;
  target?: { type: string; id: string; name?: string; departmentId?: string };
  changes?: { field: string; before?: unknown; after?: unknown }[];
  arbitration?: ArbitrationAuditDetail;
  metadata?: Record<string, unknown>;
}
