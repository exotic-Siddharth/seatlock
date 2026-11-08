import type { Hold, HoldStatus, MyHold, SeatChange, StrategyName, VenueLayout } from '@seatlock/shared';
import type { AppDeps } from '../context';
import { withTx, type Queryable } from '../db';
import { AppError } from '../errors';
import { verifyQueueToken } from '../queue/token';
import { closeCheckouts, endHolds } from './seats';
import { loadSeats, readHold, toHold } from './serialize';
import { getStrategy } from './strategies';
import { clearSeatGates, releaseSeatGates } from './strategies/redis';
import type { FreedSeat, HoldInput, HoldResult } from './strategies/types';

/** Seconds a holds-per-second counter lives; the admin dashboard reads the last 60. */
const HPS_TTL_SEC = 120;

/**
 * After a commit that changed seats: tells every API instance (so every open seat map) and
 * drops the Redis gates of the freed seats. The change is already committed, so a Redis error
 * here is logged instead of turning a successful request into a failed one.
 */
export async function afterSeatsChanged(
  deps: AppDeps,
  eventId: string,
  changes: SeatChange[],
  freed: FreedSeat[] = [],
): Promise<void> {
  await Promise.all([deps.publisher.publish(eventId, changes), releaseSeatGates(deps.redis, freed)]).catch(
    (err: unknown) => deps.log.warn({ err, eventId }, 'could not announce seat changes'),
  );
}

export const freedChanges = (freed: FreedSeat[]): SeatChange[] => freed.map((s) => ({ id: s.id, st: 'A' }));

type HoldableEvent = {
  id: string;
  slug: string;
  title: string;
  layout: VenueLayout;
  queueEnabled: boolean;
  maxSeatsPerOrder: number;
  holdTtlSeconds: number;
  saleOpen: boolean;
  saleClosed: boolean;
};

async function loadEvent(db: Queryable, eventId: string): Promise<HoldableEvent | undefined> {
  const { rows } = await db.query<HoldableEvent>(
    `SELECT e.id, e.slug, e.title, v.layout, e.queue_enabled AS "queueEnabled",
            e.max_seats_per_order AS "maxSeatsPerOrder", e.hold_ttl_seconds AS "holdTtlSeconds",
            now() >= e.sale_opens_at AS "saleOpen", now() >= e.starts_at AS "saleClosed"
       FROM events e JOIN venues v ON v.id = e.venue_id
      WHERE e.id = $1`,
    [eventId],
  );
  return rows[0];
}

/** Runs the strategy and records `seatlock_hold_attempts_total` and `seatlock_hold_duration_seconds`. */
async function runStrategy(deps: AppDeps, name: StrategyName, input: HoldInput): Promise<HoldResult> {
  const stopTimer = deps.metrics.holdDuration.startTimer({ strategy: name });
  try {
    const result = await getStrategy(name).hold(deps, input);
    deps.metrics.holdAttempts.inc({ strategy: name, result: result.ok ? 'ok' : 'conflict' });
    return result;
  } catch (e) {
    deps.metrics.holdAttempts.inc({ strategy: name, result: 'error' });
    throw e;
  } finally {
    stopTimer();
  }
}

export type HoldRequest = {
  userId: string;
  eventId: string;
  /** Distinct (the request schema guarantees it). */
  seatIds: number[];
  strategy: StrategyName;
  queueToken: string | undefined;
};

/** POST /api/holds: the pre-checks of spec §7.1, in order, then the strategy. */
export async function createHold(deps: AppDeps, req: HoldRequest): Promise<Hold> {
  const [event, seats] = await Promise.all([loadEvent(deps.db, req.eventId), loadSeats(deps.db, req.eventId, req.seatIds)]);
  if (!event) throw new AppError('NOT_FOUND', 'Event not found');
  if (!event.saleOpen) throw new AppError('SALE_NOT_OPEN', 'The sale for this event has not opened yet');
  if (event.saleClosed) throw new AppError('SALE_CLOSED', 'The sale for this event has closed');
  if (req.seatIds.length > event.maxSeatsPerOrder) {
    throw new AppError('TOO_MANY_SEATS', `You can hold up to ${event.maxSeatsPerOrder} seats`, {
      maxSeatsPerOrder: event.maxSeatsPerOrder,
    });
  }
  // Checked before any strategy runs, so a foreign id is a 400 and never a false "taken".
  const known = new Set(seats.map((s) => s.id));
  const unknownSeatIds = req.seatIds.filter((id) => !known.has(id));
  if (unknownSeatIds.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'Some of these seats are not part of this event', { unknownSeatIds });
  }
  if (event.queueEnabled) {
    if (!req.queueToken) throw new AppError('QUEUE_REQUIRED', 'Join the waiting room to buy seats for this event');
    if (!verifyQueueToken(deps.config.queueTokenSecret, req.queueToken, { eventId: event.id, userId: req.userId })) {
      throw new AppError('QUEUE_TOKEN_INVALID', 'Your waiting-room pass is not valid for this event any more');
    }
  }

  const input = { eventId: event.id, userId: req.userId, seatIds: req.seatIds, ttlSec: event.holdTtlSeconds };
  const result = await runStrategy(deps, req.strategy, input);
  if (!result.ok) {
    const n = result.takenSeatIds.length;
    throw new AppError('SEATS_UNAVAILABLE', `${n} of your seats ${n === 1 ? 'was' : 'were'} just taken`, {
      takenSeatIds: result.takenSeatIds,
    });
  }

  // Freed first, held last: a seat moved from the old hold to the new one ends up 'H'.
  const held: SeatChange[] = req.seatIds.map((id) => ({ id, st: 'H' }));
  await afterSeatsChanged(deps, event.id, [...freedChanges(result.freed), ...held], result.freed);
  const counter = `sl:hps:${event.id}:${Math.floor(Date.now() / 1000)}`;
  await deps.redis
    .multi()
    .incr(counter)
    .expire(counter, HPS_TTL_SEC)
    .exec()
    .catch((err: unknown) => deps.log.warn({ err }, 'could not count the hold'));

  return toHold({ ...result.hold, orderId: null }, event, seats);
}

/** GET /api/holds/:id. Someone else's hold is reported as not found, not forbidden. */
export async function getHold(db: Queryable, holdId: string, userId: string): Promise<Hold> {
  const found = await readHold(db, holdId);
  if (!found || found.userId !== userId) throw new AppError('NOT_FOUND', 'Hold not found');
  return found.hold;
}

/**
 * DELETE /api/holds/:id: gives the seats back, unless they are paid for or a payment for them
 * is in flight (CHECKOUT_IN_PROGRESS). An unpaid order of the hold, say after a declined card,
 * fails with RELEASED.
 */
export async function releaseHold(deps: AppDeps, holdId: string, userId: string): Promise<void> {
  const { eventId, freed } = await withTx(deps.db, async (c) => {
    const { rows } = await c.query<{ eventId: string; status: HoldStatus }>(
      'SELECT event_id AS "eventId", status FROM holds WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [holdId, userId],
    );
    const hold = rows[0];
    if (!hold) throw new AppError('NOT_FOUND', 'Hold not found');
    if (hold.status === 'converted') throw new AppError('HOLD_NOT_ACTIVE', 'These seats are already paid for');
    if (hold.status !== 'active') return { eventId: hold.eventId, freed: [] }; // already over: nothing to do
    await closeCheckouts(c, [holdId], 'RELEASED', 'refuse');
    return { eventId: hold.eventId, freed: await endHolds(c, [holdId], 'released') };
  });
  await afterSeatsChanged(deps, eventId, freedChanges(freed), freed);
}

/** The user's active, unexpired hold on the event, or null (SeatSnapshot.myHold). */
export async function getActiveHoldForUser(db: Queryable, userId: string, eventId: string): Promise<MyHold | null> {
  const { rows } = await db.query<{ id: string; seatIds: number[]; expiresAt: Date }>(
    `SELECT id, seat_ids AS "seatIds", expires_at AS "expiresAt"
       FROM holds
      WHERE user_id = $1 AND event_id = $2 AND status = 'active' AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, eventId],
  );
  const hold = rows[0];
  return hold ? { id: hold.id, seatIds: hold.seatIds, expiresAt: hold.expiresAt.toISOString() } : null;
}

/** Deletes the event's holds, orders, tickets and intents, frees every seat and clears its Redis seat keys (bench reset). */
export async function releaseHoldsForEvent(deps: AppDeps, eventId: string): Promise<void> {
  const { seatIds, changed } = await withTx(deps.db, async (c) => {
    // Deleting the orders cascades to their tickets and payment intents.
    await c.query('DELETE FROM orders WHERE event_id = $1', [eventId]);
    await c.query('DELETE FROM holds WHERE event_id = $1', [eventId]);
    const reset = await c.query<{ id: number }>(
      `UPDATE event_seats
          SET status = 'available', hold_id = NULL, held_until = NULL, order_id = NULL, updated_at = now()
        WHERE event_id = $1 AND status <> 'available'
        RETURNING id`,
      [eventId],
    );
    const all = await c.query<{ id: number }>('SELECT id FROM event_seats WHERE event_id = $1', [eventId]);
    return { seatIds: all.rows.map((r) => r.id), changed: reset.rows.map((r) => r.id) };
  });
  await clearSeatGates(deps.redis, eventId, seatIds);
  await afterSeatsChanged(deps, eventId, changed.map((id) => ({ id, st: 'A' })));
}
