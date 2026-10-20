import { z } from 'zod';
import { NotificationChannel, NotificationSeverity } from '@/constants/enums';
import { auditableShape, isoDateTime } from './base.model';

/**
 * Notification.
 *
 * DELIVERY MODEL
 * ==============
 * Notifications are PERSISTED FIRST and delivered second. A notification that exists only
 * in a websocket frame is lost for every operator who was not looking at the screen — which
 * during a night-shift incident is all of them.
 *
 * `broadcast: true` targets everyone with sufficient role; otherwise `recipientId` targets
 * one user. Both are supported because "the network is oversubscribed" is everyone's
 * problem while "your slice was degraded" belongs to a specific department owner.
 */
export const NotificationSchema = z.object({
  ...auditableShape,

  severity: z.nativeEnum(NotificationSeverity),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),

  /** Broadcast to all users with `minimumRole`, rather than to one recipient. */
  broadcast: z.boolean().default(false),
  recipientId: z.string().max(128).optional(),
  /** Minimum role required to see a broadcast. */
  minimumRole: z.enum(['VIEWER', 'MANAGER', 'ADMIN']).default('VIEWER'),

  /** What this is about, so the UI can deep-link. */
  subject: z
    .object({
      type: z.string().max(64),
      id: z.string().max(128),
      name: z.string().max(200).optional(),
    })
    .optional(),

  channels: z.array(z.nativeEnum(NotificationChannel)).default([NotificationChannel.DASHBOARD]),
  /** Channels that actually accepted the message. */
  deliveredChannels: z.array(z.nativeEnum(NotificationChannel)).default([]),
  deliveryErrors: z.array(z.string().max(500)).max(10).default([]),

  read: z.boolean().default(false),
  readAt: isoDateTime.optional(),

  at: isoDateTime,
  atMs: z.number().int().nonnegative(),

  /** Optional deep-link path within the SPA, e.g. `/arbitration/ARB-123`. */
  link: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationQuerySchema = z.object({
  severity: z.nativeEnum(NotificationSeverity).optional(),
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

export const MarkReadSchema = z
  .object({ ids: z.array(z.string().min(1)).min(1).max(200) })
  .strict();
