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

/** Inserts an active hold priced at the sum of its seats, expiring `ttlSec` from the database's now(). */
export async function insertHold(
  c: Queryable,
  input: HoldInput,
  strategy: StrategyName,
  id: string = randomUUID(),
): Promise<HoldRow> {
  const { rows } = await c.query<HoldRow>(
    `INSERT INTO holds (id, event_id, user_id, seat_ids, amount_paise, strategy, expires_at)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::bigint[], sum(price_paise), $5::text, now() + make_interval(secs => $6)
       FROM event_seats WHERE event_id = $2 AND id = ANY($4)
     RETURNING ${HOLD_COLUMNS}`,
    [id, input.eventId, input.userId, input.seatIds, strategy, input.ttlSec],
  );
  return rows[0]!;
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

/** A hold whose order awaits payment keeps its seats: the money for them may already be on its way. */
export async function assertNotInCheckout(c: Queryable, holdIds: string[]): Promise<void> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM orders WHERE hold_id = ANY($1) AND status = 'pending_payment'`,
    [holdIds],
  );
  if (rowCount) {
    throw new AppError('CHECKOUT_IN_PROGRESS', 'You are paying for seats on this event; finish or wait for the hold to end');
  }
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
 * failed new hold rolls this back too. Throws CHECKOUT_IN_PROGRESS if that hold is being paid for.
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
  // A separate statement, after the lock: it sees an order committed while we waited for the lock.
  await assertNotInCheckout(c, ids);
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
       UPDATE holds SET status = $2, ended_at = LEAST(now(), expires_at)
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
