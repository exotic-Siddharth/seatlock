import { withTx } from '../db';
import type { AppDeps } from '../context';

/**
 * Puts a bench event back to a fresh, fully available state: deletes its tickets, orders
 * (payment intents go with them) and holds, frees every seat, and removes every Redis key that
 * mentions the event (seat gates, the waiting room, its token keys).
 * Only for bench events; nothing here is reachable from the HTTP API.
 */
export async function resetBenchEvent(deps: Pick<AppDeps, 'db' | 'redis'>, eventId: string): Promise<void> {
  await withTx(deps.db, async (c) => {
    // Orders reference holds, so they go first. Tickets and payment intents cascade from orders.
    await c.query('DELETE FROM orders WHERE event_id = $1', [eventId]);
    await c.query('DELETE FROM holds WHERE event_id = $1', [eventId]);
    await c.query(
      `UPDATE event_seats SET status = 'available', hold_id = NULL, held_until = NULL, order_id = NULL, updated_at = now()
        WHERE event_id = $1 AND (status <> 'available' OR hold_id IS NOT NULL OR order_id IS NOT NULL)`,
      [eventId],
    );
  });

  // The pattern is built from a uuid, so it contains no glob characters of its own.
  let cursor = '0';
  do {
    const [next, keys] = await deps.redis.scan(cursor, 'MATCH', `sl:*${eventId}*`, 'COUNT', 1000);
    if (keys.length > 0) await deps.redis.unlink(...keys);
    cursor = next;
  } while (cursor !== '0');
}
