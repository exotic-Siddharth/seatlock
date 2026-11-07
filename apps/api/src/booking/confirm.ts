import type { OrderStatus, StrategyName } from '@seatlock/shared';
import type pg from 'pg';
import type { AppDeps } from '../context';
import { pgCode, withTx } from '../db';
import type { PaymentEvent } from '../payments/mockpay.service';
import { newTicketCode } from './codes';
import { afterSeatsChanged, freedChanges } from './holds.service';
import { endHolds } from './seats';
import { markSeatGatesSold } from './strategies/redis';
import type { FreedSeat } from './strategies/types';

type PayingOrder = {
  id: string;
  userId: string;
  eventId: string;
  holdId: string;
  status: OrderStatus;
  seatIds: number[];
  strategy: StrategyName;
};

type Outcome = { kind: 'paid'; order: PayingOrder } | { kind: 'failed'; order: PayingOrder; freed: FreedSeat[] };

/**
 * Applies a verified MockPay webhook (spec §7.2) in one transaction: each event id at most
 * once, and only while the order still awaits payment. Announces the seat changes after commit.
 */
export async function applyPaymentEvent(deps: AppDeps, event: PaymentEvent): Promise<void> {
  const outcome = await withTx(deps.db, async (c) => {
    const fresh = await c.query('INSERT INTO webhook_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      event.id,
      event.type,
    ]);
    if (fresh.rowCount === 0) return null; // a redelivery of an event already applied

    // The hold is locked with the order, before any seat: the sweeper (which skips locked holds)
    // and order creation (which locks the hold first) then wait for this transaction or pass it by.
    const { rows } = await c.query<PayingOrder>(
      `SELECT o.id, o.user_id AS "userId", o.event_id AS "eventId", o.hold_id AS "holdId", o.status,
              h.seat_ids AS "seatIds", h.strategy
         FROM payment_intents pi
         JOIN orders o ON o.id = pi.order_id
         JOIN holds h ON h.id = o.hold_id
        WHERE pi.id = $1
          FOR UPDATE OF o, h`,
      [event.data.intentId],
    );
    const order = rows[0];
    if (!order || order.status !== 'pending_payment') return null;

    if (event.type === 'payment_intent.failed') {
      // The hold stays as it is, so the buyer can try another card until it expires.
      await c.query(`UPDATE payment_intents SET status = 'failed', failure_code = $2, updated_at = now() WHERE id = $1`, [
        event.data.intentId,
        event.data.failureCode ?? 'card_declined',
      ]);
      await c.query(`UPDATE orders SET failure_reason = 'PAYMENT_DECLINED' WHERE id = $1`, [order.id]);
      return null;
    }
    return sell(c, order, event.data.intentId);
  });

  if (outcome) await announce(deps, outcome);
}

async function sell(c: pg.PoolClient, order: PayingOrder, intentId: string): Promise<Outcome> {
  // If the sale can't complete, everything from here is undone and the order fails cleanly.
  await c.query('SAVEPOINT sell');
  const sold = await sellSeats(c, order);
  if (sold.length !== order.seatIds.length) {
    await c.query('ROLLBACK TO SAVEPOINT sell');
    return failOrder(c, order, intentId, 'HOLD_LOST');
  }
  try {
    await c.query(
      `INSERT INTO tickets (order_id, event_id, event_seat_id, user_id, code)
       SELECT $1::uuid, $2::uuid, seat_id, $3::uuid, code FROM unnest($4::bigint[], $5::text[]) AS t(seat_id, code)`,
      [order.id, order.eventId, order.userId, sold, sold.map(() => newTicketCode())],
    );
  } catch (e) {
    // tickets.event_seat_id is UNIQUE: the last line of defence when a seat was sold twice.
    if (pgCode(e) !== '23505') throw e;
    await c.query('ROLLBACK TO SAVEPOINT sell');
    return failOrder(c, order, intentId, 'SEAT_ALREADY_SOLD');
  }

  await c.query(`UPDATE orders SET status = 'paid', paid_at = now(), failure_reason = NULL WHERE id = $1`, [order.id]);
  await c.query(`UPDATE holds SET status = 'converted', ended_at = clock_timestamp() WHERE id = $1`, [order.holdId]);
  await c.query(`UPDATE payment_intents SET status = 'succeeded', failure_code = NULL, updated_at = now() WHERE id = $1`, [
    intentId,
  ]);
  return { kind: 'paid', order };
}

/**
 * Safe path: sells only the seats this hold still holds. There is deliberately no held_until
 * check: a late payment still wins if nobody took the seats after the hold lapsed.
 * Naive path (bench only): sells by seat id with no ownership check, so only the UNIQUE
 * ticket constraint stands between two buyers and one seat.
 */
async function sellSeats(c: pg.PoolClient, order: PayingOrder): Promise<number[]> {
  const { rows } =
    order.strategy === 'naive'
      ? await c.query<{ id: number }>(
          `UPDATE event_seats SET status = 'sold', order_id = $1, hold_id = NULL, held_until = NULL, updated_at = now()
            WHERE id = ANY($2)
            RETURNING id`,
          [order.id, order.seatIds],
        )
      : await c.query<{ id: number }>(
          `UPDATE event_seats SET status = 'sold', order_id = $1, hold_id = NULL, held_until = NULL, updated_at = now()
            WHERE hold_id = $2 AND status = 'held'
            RETURNING id`,
          [order.id, order.holdId],
        );
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

async function failOrder(
  c: pg.PoolClient,
  order: PayingOrder,
  intentId: string,
  reason: 'HOLD_LOST' | 'SEAT_ALREADY_SOLD',
): Promise<Outcome> {
  // The hold is over either way: free whatever seats it still has so they go back on sale.
  const freed = await endHolds(c, [order.holdId], reason === 'HOLD_LOST' ? 'expired' : 'released');
  await c.query(`UPDATE orders SET status = 'failed', failure_reason = $2 WHERE id = $1`, [order.id, reason]);
  // MockPay has already taken the money, so it goes back to the buyer.
  await c.query(`UPDATE payment_intents SET status = 'refunded', updated_at = now() WHERE id = $1`, [intentId]);
  return { kind: 'failed', order, freed };
}

async function announce(deps: AppDeps, outcome: Outcome): Promise<void> {
  const { order } = outcome;
  deps.metrics.orders.inc({ status: outcome.kind });
  if (outcome.kind === 'failed') {
    await afterSeatsChanged(deps, order.eventId, freedChanges(outcome.freed), outcome.freed);
    return;
  }
  await afterSeatsChanged(
    deps,
    order.eventId,
    order.seatIds.map((id) => ({ id, st: 'S' })),
  );
  if (order.strategy === 'redis') {
    await markSeatGatesSold(deps.redis, order.eventId, order.seatIds).catch((err: unknown) =>
      deps.log.warn({ err }, 'could not mark the seat gates sold'),
    );
  }
}
