import { EventEmitter } from 'node:events';
import { Collections } from '@/constants/collections';
import { NotificationChannel, NotificationSeverity, UserRole } from '@/constants/enums';
import type { IClock } from '@/interfaces/clock.port';
import type { IDatastore, IRepository } from '@/interfaces/repository.port';
import type { Notification } from '@/models/notification.model';
import type { Page, QueryFilter } from '@/types/common';
import { createLogger } from '@/utils/logger';

const log = createLogger('notifications');

/**
 * Notification service.
 *
 * CHANNEL ABSTRACTION
 * ===================
 * The specification calls for dashboard notifications now and email/Slack/Teams later. The
 * naive reading is to write the dashboard path today and add `if (channel === 'SLACK')`
 * branches later — which produces a service that grows a new conditional per integration
 * and cannot be tested without all of them.
 *
 * Instead, delivery is a registry of `NotificationChannelHandler`s. The dashboard handler
 * is registered at construction; adding Slack means writing one handler and registering it
 * in the composition root. No branch in this file changes.
 *
 * PERSIST FIRST, DELIVER SECOND
 * =============================
 * Every notification is written to the datastore before any delivery is attempted. A
 * notification that exists only in a websocket frame is lost for every operator who was not
 * looking at the screen — during a 03:00 incident, that is all of them. Delivery failures
 * are recorded ON the notification rather than thrown, so a broken Slack webhook cannot
 * stop an arbitration decision from completing.
 */

export interface NotificationChannelHandler {
  readonly channel: NotificationChannel;
  /** @throws to record a delivery failure; never propagates to the caller. */
  deliver(notification: Notification): Promise<void>;
}

export interface NotificationEvents {
  created: (notification: Notification) => void;
}

export interface CreateNotificationInput {
  severity: NotificationSeverity;
  title: string;
  body: string;
  broadcast?: boolean;
  recipientId?: string;
  minimumRole?: UserRole;
  subject?: { type: string; id: string; name?: string };
  channels?: NotificationChannel[];
  link?: string;
  metadata?: Record<string, unknown>;
}

export class NotificationService {
  private readonly repo: IRepository<Notification>;
  private readonly handlers = new Map<NotificationChannel, NotificationChannelHandler>();
  private readonly emitter = new EventEmitter();

  constructor(
    datastore: IDatastore,
    private readonly clock: IClock,
  ) {
    this.repo = datastore.repository<Notification>(Collections.NOTIFICATIONS);
    this.emitter.setMaxListeners(50);

    // The dashboard channel is the persisted record plus an in-process event that the
    // realtime gateway (Module 10) forwards to connected clients.
    this.register({
      channel: NotificationChannel.DASHBOARD,
      deliver: async () => {
        // Persistence IS the dashboard delivery; the event is emitted by `create`.
      },
    });
  }

  register(handler: NotificationChannelHandler): void {
    this.handlers.set(handler.channel, handler);
    log.info({ channel: handler.channel }, 'notification channel registered');
  }

  on<E extends keyof NotificationEvents>(event: E, listener: NotificationEvents[E]): void {
    this.emitter.on(event, listener);
  }

  off<E extends keyof NotificationEvents>(event: E, listener: NotificationEvents[E]): void {
    this.emitter.off(event, listener);
  }

  /** Create and deliver. Never throws — see the delivery model above. */
  async create(input: CreateNotificationInput): Promise<Notification | null> {
    const now = this.clock.now();
    const channels = input.channels ?? [NotificationChannel.DASHBOARD];

    let notification: Notification;
    try {
      notification = await this.repo.create({
        severity: input.severity,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 2000),
        broadcast: input.broadcast ?? false,
        ...(input.recipientId ? { recipientId: input.recipientId } : {}),
        minimumRole: input.minimumRole ?? UserRole.VIEWER,
        ...(input.subject ? { subject: input.subject } : {}),
        channels,
        deliveredChannels: [],
        deliveryErrors: [],
        read: false,
        at: new Date(now).toISOString(),
        atMs: now,
        ...(input.link ? { link: input.link } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
    } catch (error) {
      log.error({ err: error, title: input.title }, 'notification persistence failed');
      return null;
    }

    this.emitter.emit('created', notification);
    void this.deliver(notification);

    return notification;
  }

  /**
   * Attempt delivery on every requested channel.
   *
   * Deliberately not awaited by `create`: a slow Slack webhook must not delay the
   * arbitration decision that triggered the notification.
   */
  private async deliver(notification: Notification): Promise<void> {
    const delivered: NotificationChannel[] = [];
    const errors: string[] = [];

    for (const channel of notification.channels) {
      const handler = this.handlers.get(channel);
      if (!handler) {
        errors.push(`${channel}: no handler registered`);
        continue;
      }

      try {
        await handler.deliver(notification);
        delivered.push(channel);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'delivery failed';
        errors.push(`${channel}: ${message}`);
        log.warn({ channel, notificationId: notification.id, err: error }, 'delivery failed');
      }
    }

    // Record the outcome so an operator can see that Slack has been silently failing for
    // three days, rather than assuming everyone was notified.
    if (delivered.length !== notification.channels.length || errors.length > 0) {
      await this.repo
        .update(notification.id, { deliveredChannels: delivered, deliveryErrors: errors.slice(0, 10) })
        .catch(() => undefined);
    } else if (delivered.length > 0) {
      await this.repo.update(notification.id, { deliveredChannels: delivered }).catch(() => undefined);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Notifications visible to one user: their own, plus broadcasts at or below their role.
   *
   * Two queries rather than a disjunction, because Firestore has no OR across different
   * fields. Merged and re-sorted in memory, which is correct at notification volumes.
   */
  async forUser(
    userId: string,
    role: UserRole,
    criteria: { unreadOnly?: boolean; severity?: NotificationSeverity },
    page: { limit: number },
  ): Promise<Notification[]> {
    const visibleRoles = rolesVisibleTo(role);

    const shared: QueryFilter[] = [];
    if (criteria.unreadOnly) shared.push({ field: 'read', op: '==', value: false });
    if (criteria.severity) shared.push({ field: 'severity', op: '==', value: criteria.severity });

    const [personal, broadcasts] = await Promise.all([
      this.repo.findMany({
        filters: [...shared, { field: 'recipientId', op: '==', value: userId }],
        orderBy: [{ field: 'atMs', direction: 'desc' }],
        limit: page.limit,
      }),
      this.repo.findMany({
        filters: [
          ...shared,
          { field: 'broadcast', op: '==', value: true },
          { field: 'minimumRole', op: 'in', value: visibleRoles },
        ],
        orderBy: [{ field: 'atMs', direction: 'desc' }],
        limit: page.limit,
      }),
    ]);

    const merged = new Map<string, Notification>();
    for (const notification of [...personal, ...broadcasts]) merged.set(notification.id, notification);

    return [...merged.values()].sort((a, b) => b.atMs - a.atMs).slice(0, page.limit);
  }

  async unreadCount(userId: string, role: UserRole): Promise<number> {
    const unread = await this.forUser(userId, role, { unreadOnly: true }, { limit: 200 });
    return unread.length;
  }

  async list(page: { limit: number; cursor?: string }): Promise<Page<Notification>> {
    return this.repo.paginate({
      limit: page.limit,
      cursor: page.cursor,
      orderBy: [{ field: 'atMs', direction: 'desc' }],
    });
  }

  /**
   * Mark notifications read.
   *
   * Reads every target first, then issues write-only updates — the read-all → write-all
   * discipline the datastore transaction contract requires.
   */
  async markRead(ids: string[], userId: string, role: UserRole): Promise<number> {
    const visibleRoles = rolesVisibleTo(role);
    const found = await this.repo.findByIds(ids);
    const now = this.clock.nowIso();

    let updated = 0;
    for (const notification of found) {
      if (!notification || notification.read) continue;

      // A user may only mark their own notifications, or broadcasts they can see.
      const visible =
        notification.recipientId === userId ||
        (notification.broadcast && visibleRoles.includes(notification.minimumRole));
      if (!visible) continue;

      await this.repo.applyUpdate(notification, { read: true, readAt: now });
      updated += 1;
    }

    return updated;
  }

  async pruneOlderThan(cutoffMs: number): Promise<number> {
    return this.repo.deleteMany([{ field: 'atMs', op: '<', value: cutoffMs }]);
  }
}

/**
 * Broadcast roles a given role can see.
 *
 * Hierarchical: an ADMIN sees VIEWER, MANAGER and ADMIN broadcasts. A VIEWER sees only
 * VIEWER broadcasts, so an operational alert intended for managers is not shown to a wall
 * display in a public corridor.
 */
function rolesVisibleTo(role: UserRole): UserRole[] {
  switch (role) {
    case UserRole.ADMIN:
      return [UserRole.VIEWER, UserRole.MANAGER, UserRole.ADMIN];
    case UserRole.MANAGER:
      return [UserRole.VIEWER, UserRole.MANAGER];
    default:
      return [UserRole.VIEWER];
  }
}
