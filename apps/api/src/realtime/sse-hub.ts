import type { SeatChange, SeatCode } from '@seatlock/shared';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import type { Metrics } from '../infra/metrics';
import type { Logger } from '../logger';

export interface SseHub {
  /** Subscribes to every event's seat channel. */
  start(): Promise<void>;
  /**
   * Turns `res` into an SSE stream for `eventId`: writes the headers and keeps it open.
   * The client is removed when the connection closes; the returned function removes it early.
   */
  addClient(eventId: string, res: Response): () => void;
  /** Supplies the payload of the `stats` event sent every 2 s to each event that has clients. */
  setStatsProvider(fn: (eventId: string) => Promise<unknown>): void;
  clientCount(): number;
  /** Ends every stream and stops the timers. Safe to call more than once. */
  stop(): Promise<void>;
}

export type SseHubOptions = { flushMs?: number; statsMs?: number; heartbeatMs?: number };

const CHANNEL_PREFIX = 'sl:ev:';

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Fans seat changes from Redis out to this instance's SSE clients. Every API replica runs
 * one, so a change committed on any replica reaches every browser. Changes are batched per
 * event (200 ms by default) and only the latest status of each seat is sent.
 */
export function createSseHub(sub: Redis, log: Logger, metrics: Metrics, opts: SseHubOptions = {}): SseHub {
  const { flushMs = 200, statsMs = 2_000, heartbeatMs = 15_000 } = opts;
  const clients = new Map<string, Set<Response>>();
  const pending = new Map<string, Map<number, SeatCode>>();
  let statsProvider: ((eventId: string) => Promise<unknown>) | undefined;
  let timers: NodeJS.Timeout[] = [];

  const count = () => [...clients.values()].reduce((n, set) => n + set.size, 0);
  const broadcast = (eventId: string, data: string) => {
    for (const res of clients.get(eventId) ?? []) res.write(data);
  };

  const onMessage = (_pattern: string, channel: string, message: string) => {
    const eventId = channel.slice(CHANNEL_PREFIX.length);
    if (!clients.has(eventId)) return;
    let changes: SeatChange[];
    try {
      changes = (JSON.parse(message) as { changes: SeatChange[] }).changes;
    } catch {
      log.warn({ channel }, 'ignoring malformed seat message');
      return;
    }
    const batch = pending.get(eventId) ?? new Map<number, SeatCode>();
    pending.set(eventId, batch);
    for (const change of changes) batch.set(change.id, change.st);
  };

  const flush = () => {
    for (const [eventId, batch] of pending) {
      broadcast(eventId, frame('seats', { changes: [...batch].map(([id, st]) => ({ id, st })) }));
    }
    pending.clear();
  };

  const sendStats = async () => {
    const provider = statsProvider;
    if (!provider) return;
    await Promise.all(
      [...clients.keys()].map(async (eventId) => {
        try {
          broadcast(eventId, frame('stats', await provider(eventId)));
        } catch (err) {
          log.warn({ err, eventId }, 'SSE stats provider failed');
        }
      }),
    );
  };

  const heartbeat = () => {
    for (const set of clients.values()) for (const res of set) res.write(':hb\n\n');
  };

  /** Ends every stream. Clients are detached first, so nothing writes to an ended response. */
  const closeAll = (): number => {
    const open = [...clients.values()].flatMap((set) => [...set]);
    clients.clear();
    pending.clear();
    for (const res of open) res.end();
    metrics.sseClients.set(0);
    return open.length;
  };

  // Messages published while the subscriber was disconnected are lost. Ending the streams
  // makes each browser's EventSource reconnect and re-fetch its seat snapshot.
  const onReconnect = () => {
    log.warn({ clients: closeAll() }, 'seat subscriber reconnected; closed SSE streams so clients re-sync');
  };

  return {
    async start() {
      sub.on('pmessage', onMessage);
      await sub.psubscribe(`${CHANNEL_PREFIX}*`);
      // The first 'ready' fired before psubscribe resolved; any later one is ioredis reconnecting.
      sub.on('ready', onReconnect);
      timers = [
        setInterval(flush, flushMs),
        setInterval(() => void sendStats(), statsMs),
        setInterval(heartbeat, heartbeatMs),
      ];
      for (const t of timers) t.unref();
    },

    addClient(eventId, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
      });
      res.write(':ok\n\n');

      const set = clients.get(eventId) ?? new Set<Response>();
      clients.set(eventId, set);
      set.add(res);
      metrics.sseClients.set(count());

      const remove = () => {
        set.delete(res);
        if (set.size === 0 && clients.get(eventId) === set) {
          clients.delete(eventId);
          pending.delete(eventId);
        }
        metrics.sseClients.set(count());
      };
      res.on('close', remove);
      return remove;
    },

    setStatsProvider(fn) {
      statsProvider = fn;
    },

    clientCount: count,

    async stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
      sub.off('pmessage', onMessage);
      sub.off('ready', onReconnect);
      closeAll();
      if (sub.status === 'ready') await sub.punsubscribe(`${CHANNEL_PREFIX}*`).catch(() => undefined);
    },
  };
}
