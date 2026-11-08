import { randomUUID } from 'node:crypto';
import type { StrategyName } from '@seatlock/shared';
import type pg from 'pg';
import { withTx, type Queryable } from '../db';
import { AppError } from '../errors';
import type { FreedSeat, HoldInput, HoldResult, HoldRow, HoldSuccess } from './strategies/types';

/*
 * SQL shared by the hold strategies, hold release, payment confirmation and the sweeper.
 * Each strategy's own hot-path statement lives in its file under strategies/.
 */

/** Thrown inside a strategy's transaction to roll it back because some seats are taken. */
export class SeatsTaken extends Error {
  constructor(readonly takenSeatIds: number[]) {
    super('Seats taken');
    this.name = 'SeatsTaken';
  }
}

/** Runs a strategy's transaction. A SeatsTaken thrown inside rolls it back and becomes `{ok: false}`. */
export async function holdInTx(
  db: pg.Pool,
  fn: (c: pg.PoolClient) => Promise<HoldSuccess>,
): Promise<HoldResult> {
  try {
    return await withTx(db, fn);
  } catch (e) {
    if (e instanceof SeatsTaken) return { ok: false, takenSeatIds: e.takenSeatIds };
    throw e;
  }
}

const HOLD_COLUMNS = `id, event_id AS "eventId", user_id AS "userId", seat_ids AS "seatIds",
  amount_paise AS "amountPaise", strategy, status, expires_at AS "expiresAt", created_at AS "createdAt"`;

/*
 * Hold timestamps use clock_timestamp(), the moment of the statement, not now(), which is when
 * the transaction began. A hold must not appear to start before the seats were really won: if a
 * buyer's transaction begins, another buyer releases the seat and commits, and only then does
 * the first win it, a now() stamp would make the two holds overlap on paper (the bench verifier
 * counts that as a double promise).
 */

/**
 * Inserts an active hold priced at the sum of its seats, expiring `ttlSec` from the database's
 * now(). `created_at` is the moment of this statement, which is when pessimistic (already holding
 * its row locks) and naive win their seats; the conditional claim restamps it with stampWon.
 */
export async function insertHold(
  c: Queryable,
  input: HoldInput,
  strategy: StrategyName,
  id: string = randomUUID(),
): Promise<HoldRow> {
  const { rows } = await c.query<HoldRow>(
    `INSERT INTO holds (id, event_id, user_id, seat_ids, amount_paise, strategy, expires_at, created_at)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::bigint[], sum(price_paise), $5::text,
            now() + make_interval(secs => $6), clock_timestamp()
       FROM event_seats WHERE event_id = $2 AND id = ANY($4)
     RETURNING ${HOLD_COLUMNS}`,
    [id, input.eventId, input.userId, input.seatIds, strategy, input.ttlSec],
  );
  return rows[0]!;
}

/** Restamps a hold's `created_at` to now, right after its seats were won; returns the stamp. */
export async function stampWon(c: Queryable, holdId: string): Promise<Date> {
  const { rows } = await c.query<{ createdAt: Date }>(
    'UPDATE holds SET created_at = clock_timestamp() WHERE id = $1 RETURNING created_at AS "createdAt"',
    [holdId],
  );
  return rows[0]!.createdAt;
}

/**
 * Marks the hold's seats held without looking at their status. Only safe when the rows are
 * already locked and checked (pessimistic); naive uses it anyway, which is its bug.
 * `held_until` is copied from the hold, so a seat and its hold always expire at the same instant.
 */
export async function markSeatsHeld(c: Queryable, hold: HoldRow): Promise<void> {
  await c.query(
    `UPDATE event_seats
        SET status = 'held', hold_id = $1, held_until = (SELECT expires_at FROM holds WHERE id = $1), updated_at = now()
      WHERE id = ANY($2)`,
    [hold.id, hold.seatIds],
  );
}

/**
 * A payment is in flight for the intent aliased `pi`: MockPay accepted a card for it less than
 * 60 s ago and its webhook has not landed yet. While this holds, the hold keeps its seats, so
 * the money on its way can still buy them. It is the sweeper's grace (spec §7.3) and the only
 * case in which a buyer cannot give seats back (see the Decisions log).
 */
export const PAYMENT_IN_FLIGHT_SQL = (pi: string) =>
  `(${pi}.status = 'processing' AND ${pi}.updated_at > now() - interval '60 seconds')`;

/** Why an unpaid order failed: its hold ended before anyone paid. */
export type CheckoutEnd = 'RELEASED' | 'REPLACED' | 'HOLD_EXPIRED';

const checkoutInProgress = () =>
  new AppError('CHECKOUT_IN_PROGRESS', 'A payment for your seats on this event is still processing; wait a moment for it to finish');

/*
 * Lock order wherever a checkout is touched: hold, then order, then payment intent, then seats
 * (order creation, release, the sweeper, the webhook). Confirm locks only the order and the
 * intent, in that order. Taken the same way round, two of them never wait on each other in a cycle.
 */

/**
 * Ends the checkouts of holds that are about to end: each order still awaiting payment fails
 * with `reason`, and its intent is marked failed (refunded, had its money already arrived).
 * The orders and intents are locked first, so a confirm or webhook for them waits and then
 * sees the result. A hold whose payment is in flight keeps its order: with `whilePaying:
 * 'refuse'` that throws CHECKOUT_IN_PROGRESS before anything changes; with 'skip' the hold is
 * returned, for the caller to leave alone too.
 */
export async function closeCheckouts(
  c: Queryable,
  holdIds: string[],
  reason: CheckoutEnd,
  whilePaying: 'refuse' | 'skip',
): Promise<Set<string>> {
  const paying = new Set<string>();
  if (holdIds.length === 0) return paying;
  const { rows } = await c.query<{ id: string; holdId: string; paying: boolean }>(
    `SELECT o.id, o.hold_id AS "holdId", ${PAYMENT_IN_FLIGHT_SQL('pi')} AS paying
       FROM orders o JOIN payment_intents pi ON pi.order_id = o.id
      WHERE o.hold_id = ANY($1) AND o.status = 'pending_payment'
        FOR UPDATE OF o, pi`,
    [holdIds],
  );
  for (const row of rows) if (row.paying) paying.add(row.holdId);
  if (paying.size > 0 && whilePaying === 'refuse') throw checkoutInProgress();

  const unpaid = rows.filter((r) => !r.paying).map((r) => r.id);
  if (unpaid.length > 0) {
    await c.query(`UPDATE orders SET status = 'failed', failure_reason = $2 WHERE id = ANY($1)`, [unpaid, reason]);
    await c.query(
      `UPDATE payment_intents
          SET status = CASE WHEN status = 'succeeded' THEN 'refunded' ELSE 'failed' END, updated_at = now()
        WHERE order_id = ANY($1)`,
      [unpaid],
    );
  }
  return paying;
}

/**
 * The id of the buyer's unexpired active hold on the event, read without a lock: the redis
 * strategy needs it before its Lua call, and its transaction re-checks everything under
 * lockBuyer. Throws CHECKOUT_IN_PROGRESS just as releasePreviousHold would, so every strategy
 * gives that answer ahead of any seat conflict.
 */
export async function peekPreviousHold(db: Queryable, userId: string, eventId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string; paying: boolean }>(
    `SELECT h.id,
            EXISTS (SELECT 1 FROM orders o JOIN payment_intents pi ON pi.order_id = o.id
                     WHERE o.hold_id = h.id AND o.status = 'pending_payment' AND ${PAYMENT_IN_FLIGHT_SQL('pi')}) AS paying
       FROM holds h
      WHERE h.user_id = $1 AND h.event_id = $2 AND h.status = 'active' AND h.expires_at > now()
      ORDER BY h.created_at DESC
      LIMIT 1`,
    [userId, eventId],
  );
  if (rows[0]?.paying) throw checkoutInProgress();
  return rows[0]?.id ?? null;
}

/**
 * Makes one buyer's concurrent hold requests for one event take turns until commit. Without
 * it, two requests sent at once could both find no previous hold and leave the buyer with two.
 * It must be its own statement: the statements after it then see what the other request committed.
 */
export async function lockBuyer(c: Queryable, userId: string, eventId: string): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`, [userId, eventId]);
}

/**
 * Ends the user's unexpired active hold on the event, so one buyer holds at most one batch
 * of seats per event. Called first inside each strategy's transaction (after lockBuyer), so a
 * failed new hold rolls this back too. An unpaid order of that hold fails with REPLACED; while
 * a payment for it is in flight, this throws CHECKOUT_IN_PROGRESS instead and the hold stays.
 */
export async function releasePreviousHold(c: Queryable, userId: string, eventId: string): Promise<FreedSeat[]> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM holds
      WHERE user_id = $1 AND event_id = $2 AND status = 'active' AND expires_at > now()
        FOR UPDATE`,
    [userId, eventId],
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // Separate statements, after the lock: they see an order or payment committed while we waited.
  await closeCheckouts(c, ids, 'REPLACED', 'refuse');
  return endHolds(c, ids, 'released');
}

/**
 * Ends active holds and frees the seats they still hold. `ended_at` is never later than
 * `expires_at`: a lapsed hold ended when it expired, not when someone noticed, so it never
 * appears to overlap the buyer who legitimately took its seats after expiry.
 */
export async function endHolds(c: Queryable, holdIds: string[], status: 'released' | 'expired'): Promise<FreedSeat[]> {
  if (holdIds.length === 0) return [];
  const { rows } = await c.query<FreedSeat>(
    `WITH ended AS (
       UPDATE holds SET status = $2, ended_at = LEAST(clock_timestamp(), expires_at)
        WHERE id = ANY($1) AND status = 'active'
       RETURNING id
     )
     UPDATE event_seats s
        SET status = 'available', hold_id = NULL, held_until = NULL, updated_at = now()
       FROM ended
      WHERE s.hold_id = ended.id AND s.status = 'held'
     RETURNING s.id, s.event_id AS "eventId", ended.id AS "holdId"`,
    [holdIds, status],
  );
  return rows.sort((a, b) => a.id - b.id);
}
