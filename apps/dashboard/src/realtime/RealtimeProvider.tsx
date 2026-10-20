import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { sessionStore } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { queryKeys } from '@/lib/queryKeys';
import type {
  ArbitrationDecision,
  CapacityState,
  ContentionEvent,
  NetworkSnapshot,
  Notification,
} from '@/types/api';

/**
 * Realtime transport.
 *
 * SOCKET EVENTS WRITE STRAIGHT INTO THE REACT QUERY CACHE.
 * =======================================================
 * The alternative — a second store holding "live" data alongside React Query's "fetched"
 * data — means every component has to know which source is authoritative, and they
 * inevitably disagree during a reconnect.
 *
 * Instead, an incoming frame calls `queryClient.setQueryData` for the same key an HTTP
 * fetch would populate. A component writes `useQuery(queryKeys.telemetry.live())` and gets
 * socket pushes when connected and polling when not, through one interface, with no
 * awareness of which is in play.
 *
 * The socket carries the same session token as the REST API and is refused before joining
 * any room if it cannot be verified.
 */

interface RealtimeState {
  connected: boolean;
  /** Non-null when the socket has failed; the UI falls back to polling and says so. */
  error: string | null;
  /** Frames received since connect — surfaced on the system status screen. */
  framesReceived: number;
}

const RealtimeContext = createContext<RealtimeState>({
  connected: false,
  error: null,
  framesReceived: 0,
});

const RealtimeEvent = {
  TELEMETRY: 'telemetry:snapshot',
  CAPACITY: 'capacity:update',
  CONTENTION_OPENED: 'contention:opened',
  CONTENTION_UPDATED: 'contention:updated',
  CONTENTION_RESOLVED: 'contention:resolved',
  ARBITRATION: 'arbitration:decision',
  NOTIFICATION: 'notification:new',
} as const;

export function RealtimeProvider({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  const queryClient = useQueryClient();

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const framesRef = useRef(0);
  const [frames, setFrames] = useState(0);

  useEffect(() => {
    if (status !== 'authenticated') return;

    const session = sessionStore.get();
    if (!session) return;

    const socket: Socket = io({
      path: '/realtime',
      auth: { token: session.accessToken },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Number.POSITIVE_INFINITY,
      // Capped exponential backoff: a NOC display left open through a deployment must
      // reconnect on its own without hammering the server while it restarts.
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15_000,
      randomizationFactor: 0.4,
    });

    socket.on('connect', () => {
      setConnected(true);
      setError(null);
    });

    socket.on('disconnect', (reason) => {
      setConnected(false);
      // A deliberate server-side disconnect will not auto-reconnect; say so rather than
      // leaving the operator watching a frozen dashboard.
      if (reason === 'io server disconnect') {
        setError('Disconnected by the server. Reload to reconnect.');
      }
    });

    socket.on('connect_error', (err) => {
      setConnected(false);
      setError(
        err.message === 'unauthorised'
          ? 'Realtime authentication failed; falling back to polling.'
          : 'Realtime connection unavailable; falling back to polling.',
      );
    });

    const countFrame = () => {
      framesRef.current += 1;
      // Batched to a second: a state update per 2 Hz frame across a dozen mounted
      // components is pure re-render churn for a counter nobody watches closely.
      if (framesRef.current % 5 === 0) setFrames(framesRef.current);
    };

    /* ---- Telemetry: the highest-frequency stream ---------------------- */
    socket.on(RealtimeEvent.TELEMETRY, (snapshot: NetworkSnapshot) => {
      countFrame();
      queryClient.setQueryData(queryKeys.telemetry.live(), {
        snapshot,
        snapshotAgeMs: 0,
        stale: false,
      });
    });

    socket.on(RealtimeEvent.CAPACITY, (capacity: CapacityState) => {
      countFrame();
      queryClient.setQueryData<{ capacity: CapacityState | null } | undefined>(
        queryKeys.capacity.current(),
        (previous) => (previous ? { ...previous, capacity } : previous),
      );
    });

    /* ---- Contention lifecycle ----------------------------------------- */
    const onContentionChanged = (event: ContentionEvent) => {
      countFrame();
      queryClient.setQueryData(queryKeys.contention.current(), (previous: unknown) => {
        const base = (previous ?? {}) as Record<string, unknown>;
        return { ...base, event, open: true };
      });
      // The history list is cheap and rarely mounted; invalidating is simpler and safer
      // than trying to splice the event into an unknown page.
      void queryClient.invalidateQueries({ queryKey: queryKeys.contention.list() });
    };

    socket.on(RealtimeEvent.CONTENTION_OPENED, onContentionChanged);
    socket.on(RealtimeEvent.CONTENTION_UPDATED, onContentionChanged);

    socket.on(RealtimeEvent.CONTENTION_RESOLVED, (event: ContentionEvent) => {
      countFrame();
      queryClient.setQueryData(queryKeys.contention.current(), (previous: unknown) => {
        const base = (previous ?? {}) as Record<string, unknown>;
        return { ...base, event: null, open: false };
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.contention.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.slices.all() });
      void queryClient.invalidateQueries({ queryKey: [event.id] });
    });

    /* ---- Arbitration -------------------------------------------------- */
    socket.on(RealtimeEvent.ARBITRATION, (decision: ArbitrationDecision) => {
      countFrame();
      queryClient.setQueryData<ArbitrationDecision[]>(queryKeys.arbitration.recent(), (previous) =>
        [decision, ...(previous ?? []).filter((d) => d.id !== decision.id)].slice(0, 20),
      );
      // Slice allocations have changed on the server; refetch rather than guess.
      void queryClient.invalidateQueries({ queryKey: queryKeys.slices.all() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.arbitration.list() });
    });

    /* ---- Notifications ------------------------------------------------ */
    socket.on(RealtimeEvent.NOTIFICATION, (notification: Notification) => {
      countFrame();
      queryClient.setQueryData<Notification[]>(queryKeys.notifications.list(), (previous) =>
        [notification, ...(previous ?? [])].slice(0, 50),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount() });
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      setConnected(false);
    };
  }, [status, queryClient]);

  const value = useMemo<RealtimeState>(
    () => ({ connected, error, framesReceived: frames }),
    [connected, error, frames],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeState {
  return useContext(RealtimeContext);
}
