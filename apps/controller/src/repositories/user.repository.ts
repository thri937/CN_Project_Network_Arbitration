import { Collections } from '@/constants/collections';
import type { UserRole } from '@/constants/enums';
import type { IDatastore, IRepository, ReadOptions } from '@/interfaces/repository.port';
import type { User } from '@/models/user.model';
import type { Page, QueryFilter } from '@/types/common';

/**
 * User repository.
 *
 * ENTITY REPOSITORY PATTERN (used by every collection in the platform)
 * ====================================================================
 * A thin, typed facade that COMPOSES the generic `IRepository<T>` rather than
 * reimplementing it. It owns exactly two things:
 *
 *   1. domain-meaningful lookups (`findBySubject`, `findByEmail`), so no service anywhere
 *      hand-builds a `QueryFilter` array and gets the field name subtly wrong;
 *   2. the collection binding, so `Collections.USERS` appears in precisely one place.
 *
 * It deliberately does NOT re-expose pagination, transactions or optimistic locking —
 * `.base` is public for that. Wrapping them would mean maintaining a parallel API surface
 * that adds no domain meaning.
 */
export class UserRepository {
  readonly base: IRepository<User>;

  constructor(datastore: IDatastore) {
    this.base = datastore.repository<User>(Collections.USERS);
  }

  /**
   * Look up by identity-provider subject. This is the join key used at every login, and
   * the reason `subject` must be indexed in Firestore.
   */
  async findBySubject(subject: string, options?: ReadOptions): Promise<User | null> {
    return this.base.findOne([{ field: 'subject', op: '==', value: subject }], options);
  }

  /**
   * Look up by email.
   *
   * Emails are normalised to lowercase on write (`emailSchema` applies `.toLowerCase()`),
   * so this comparison is exact rather than case-insensitive — Firestore has no
   * case-insensitive operator, and normalising on write is the only approach that works
   * identically in both drivers.
   */
  async findByEmail(email: string, options?: ReadOptions): Promise<User | null> {
    return this.base.findOne(
      [{ field: 'email', op: '==', value: email.trim().toLowerCase() }],
      options,
    );
  }

  async listAdmins(): Promise<User[]> {
    return this.base.findMany({
      filters: [
        { field: 'role', op: '==', value: 'ADMIN' satisfies UserRole },
        { field: 'enabled', op: '==', value: true },
      ],
    });
  }

  /** Count of enabled administrators — used to prevent removing the last one. */
  async countEnabledAdmins(options?: ReadOptions): Promise<number> {
    return this.base.count(
      [
        { field: 'role', op: '==', value: 'ADMIN' satisfies UserRole },
        { field: 'enabled', op: '==', value: true },
      ],
      options,
    );
  }

  async search(
    criteria: { role?: UserRole; enabled?: boolean },
    page: { limit: number; cursor?: string },
  ): Promise<Page<User>> {
    const filters: QueryFilter[] = [];
    if (criteria.role) filters.push({ field: 'role', op: '==', value: criteria.role });
    if (criteria.enabled !== undefined) {
      filters.push({ field: 'enabled', op: '==', value: criteria.enabled });
    }

    return this.base.paginate({
      limit: page.limit,
      cursor: page.cursor,
      filters,
      orderBy: [{ field: 'email', direction: 'asc' }],
    });
  }
}
