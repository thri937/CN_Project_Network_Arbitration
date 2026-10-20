import type http from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { env } from '@/config/env';
import { ROLE_RANK, UserRole } from '@/constants/enums';
import type { CapacityState } from '@/models/capacity.model';
import type { ContentionEvent } from '@/models/contention.model';
import type { Notification } from '@/models/notification.model';
import type { NetworkSnapshot } from '@/models/telemetry.model';
import type { ArbitrationDecision } from '@/models/arbitrationDecision.model';
import type { TokenService } from '@/services/token.service';
import { createLogger } from '@/utils/logger';

const log = createLogger('realtime');

/**
 * Realtime gateway.
 *
 * WHY SOCKET.IO RATHER THAN FIRESTORE LISTENERS
 * =============================================
 * The obvious option is to let the browser subscribe to Firestore directly. It is rejected
 * for three reasons:
 *
 *  1. The live snapshot the control loop acts on is IN MEMORY and never persisted at full
 *     rate. A Firestore listener would show the throttled, stored subset — so the dashboard
 *     would display something subtly different from what the engine is reasoning about.
 *     During an incident, that discrepancy is dangerous.
 *  2. A listener on a 2-second write stream bills a document read per client per tick.
 *     Twelve slices, six operators, one day ≈ 3.1M reads.
 *  3. Firestore rules cannot express "managers see manager broadcasts"; this gateway can.
 *
 * The frontend still uses Firestore listeners where they fit well — slices, departments,
 * policies — which change rarely and benefit from offline caching.
 *
 * AUTHENTICATION
 * ==============
 * The same session JWT as the REST API, verified in a connection middleware. An
 * unauthenticated socket is refused before it can join any room, and role is captured at
 * connect time to decide room membership.
 */

export const RealtimeEvent = {
  TELEMETRY: 'telemetry:snapshot',
  CAPACITY: 'capacity:update',
  CONTENTION_OPENED: 'contention:opened',
  CONTENTION_UPDATED: 'contention:updated',
  CONTENTION_RESOLVED: 'contention:resolved',
  ARBITRATION: 'arbitration:decision',
  NOTIFICATION: 'notification:new',
} as const;

/** Rooms are role-scoped so a broadcast cannot reach a client that may not see it. */
const Room = {
  VIEWER: 'role:viewer',
  MANAGER: 'role:manager',
  ADMIN: 'role:admin',
} as const;

interface SocketPrincipal {
  userId: string;
  email: string;
  role: UserRole;
}

export class RealtimeGateway {
  private io: SocketServer | null = null;
  private connections = 0;

  constructor(private readonly tokens: TokenService) {}

  attach(server: http.Server): void {
    if (!env.ENABLE_SOCKET_IO) {
      log.info('realtime gateway disabled by configuration');
      return;
    }

    this.io = new SocketServer(server, {
      path: '/realtime',
      cors: { origin: env.CORS_ORIGINS, credentials: true },
      // The dashboard sends nothing; only the server pushes. Small buffers are ample and
      // bound the memory a misbehaving client can consume.
      maxHttpBufferSize: 1e5,
      pingInterval: 25_000,
      pingTimeout: 20_000,
    });

    this.io.use((socket, next) => {
      try {
        const token =
          (socket.handshake.auth as { token?: string } | undefined)?.token ??
          extractBearer(socket.handshake.headers.authorization);

        if (!token) {
          next(new Error('unauthorised: no session token'));
          return;
        }

        const principal = this.tokens.verifyAccessToken(token);
        (socket.data as { principal: SocketPrincipal }).principal = {
          userId: principal.userId,
          email: principal.email,
          role: principal.role,
        };
        next();
      } catch {
        // Deliberately opaque: a client that cannot authenticate learns nothing about why.
        next(new Error('unauthorised'));
      }
    });

    this.io.on('connection', (socket) => this.onConnection(socket));

    log.info({ path: '/realtime' }, 'realtime gateway attached');
  }

  private onConnection(socket: Socket): void {
    const principal = (socket.data as { principal: SocketPrincipal }).principal;
    this.connections += 1;

    // Join every room at or below the caller's rank, so a manager receives viewer-level
    // broadcasts too without the publisher having to fan out explicitly.
    const rank = ROLE_RANK[principal.role];
    void socket.join(Room.VIEWER);
    if (rank >= ROLE_RANK[UserRole.MANAGER]) void socket.join(Room.MANAGER);
    if (rank >= ROLE_RANK[UserRole.ADMIN]) void socket.join(Room.ADMIN);
    // A private room for notifications addressed to this user specifically.
    void socket.join(`user:${principal.userId}`);

    log.debug({ userId: principal.userId, role: principal.role }, 'realtime client connected');

    socket.on('disconnect', (reason) => {
      this.connections -= 1;
      log.debug({ userId: principal.userId, reason }, 'realtime client disconnected');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Publishers                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Publish the live snapshot.
   *
   * Sent to every authenticated client at the full control-loop rate. This is the same
   * object the arbitration engine reasons about, which is the entire point: an operator
   * watching the dashboard sees precisely what the engine sees.
   */
  publishTelemetry(snapshot: NetworkSnapshot): void {
    this.io?.to(Room.VIEWER).emit(RealtimeEvent.TELEMETRY, snapshot);
  }

  publishCapacity(state: CapacityState): void {
    this.io?.to(Room.VIEWER).emit(RealtimeEvent.CAPACITY, state);
  }

  publishContentionOpened(event: ContentionEvent): void {
    this.io?.to(Room.VIEWER).emit(RealtimeEvent.CONTENTION_OPENED, event);
  }

  publishContentionUpdated(event: ContentionEvent): void {
    this.io?.to(Room.VIEWER).emit(RealtimeEvent.CONTENTION_UPDATED, event);
  }

  publishContentionResolved(event: ContentionEvent): void {
    this.io?.to(Room.VIEWER).emit(RealtimeEvent.CONTENTION_RESOLVED, event);
  }

  publishArbitration(decision: ArbitrationDecision): void {
    this.io?.to(Room.VIEWER).emit(RealtimeEvent.ARBITRATION, decision);
  }

  /** Routed by audience: a personal notification never reaches another user's socket. */
  publishNotification(notification: Notification): void {
    if (!this.io) return;

    if (notification.recipientId) {
      this.io.to(`user:${notification.recipientId}`).emit(RealtimeEvent.NOTIFICATION, notification);
      return;
    }

    const room =
      notification.minimumRole === UserRole.ADMIN
        ? Room.ADMIN
        : notification.minimumRole === UserRole.MANAGER
          ? Room.MANAGER
          : Room.VIEWER;

    this.io.to(room).emit(RealtimeEvent.NOTIFICATION, notification);
  }

  stats(): { enabled: boolean; connections: number } {
    return { enabled: this.io !== null, connections: this.connections };
  }

  async dispose(): Promise<void> {
    if (!this.io) return;
    await new Promise<void>((resolve) => this.io!.close(() => resolve()));
    this.io = null;
    log.info('realtime gateway closed');
  }
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const parts = header.split(' ').filter(Boolean);
  return parts.length === 2 && parts[0]?.toLowerCase() === 'bearer' ? parts[1] : undefined;
}
