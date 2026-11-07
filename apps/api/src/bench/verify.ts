import type { Invariants, StrategyName } from '@seatlock/shared';
import type { Queryable } from '../db';

/*
 * The benchmark's oracle: after a run, did the database end up in a state in which no seat was
 * sold twice, every sale is ticketed and every payment adds up?
 *
 * Everything is one SELECT, so it reads a single snapshot even while a late webhook is still
 * committing. Counts are cast to int in SQL, so they are numbers whatever the pg type parsers are.
 */

const INVARIANTS_SQL = `
WITH promised AS (
  -- The span in which a hold really reserved a seat. The sweeper can stamp ended_at several
  -- seconds after expires_at, and a seat may be taken over lazily in that gap, so the end is
  -- the earlier of the two. Holds are half-open: a release followed by a new hold at the same
  -- instant is not an overlap.
  SELECT h.id, unnest(h.seat_ids) AS seat_id,
         h.created_at AS from_ts,
         LEAST(COALESCE(h.ended_at, h.expires_at), h.expires_at) AS to_ts
  FROM holds h
  WHERE h.event_id = $1
)
SELECT
  -- More than one ticket on a seat. UNIQUE (event_seat_id) makes this impossible; it is checked anyway.
  (SELECT count(*)::int FROM (
     SELECT event_seat_id FROM tickets WHERE event_id = $1 GROUP BY event_seat_id HAVING count(*) > 1
   ) dup) AS "oversoldSeats",

  -- A seat marked sold has no ticket from the order that sold it.
  (SELECT count(*)::int FROM event_seats s
    WHERE s.event_id = $1 AND s.status = 'sold'
      AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.event_seat_id = s.id AND t.order_id = s.order_id)
  ) AS "soldSeatsWithoutTicket",

  -- A ticket whose seat is not sold to that same order.
  (SELECT count(*)::int FROM tickets t
    WHERE t.event_id = $1
      AND NOT EXISTS (SELECT 1 FROM event_seats s
                       WHERE s.id = t.event_seat_id AND s.event_id = t.event_id
                         AND s.status = 'sold' AND s.order_id = t.order_id)
  ) AS "ticketsOnUnsoldSeats",

  -- A paid order that does not have one ticket per seat of its hold (zero tickets included).
  (SELECT count(*)::int FROM orders o JOIN holds h ON h.id = o.hold_id
    WHERE o.event_id = $1 AND o.status = 'paid'
      AND (SELECT count(*) FROM tickets t WHERE t.order_id = o.id) <> cardinality(h.seat_ids)
  ) AS "paidOrdersWithoutTickets",

  (SELECT count(*)::int FROM tickets t JOIN orders o ON o.id = t.order_id
    WHERE t.event_id = $1 AND o.status <> 'paid'
  ) AS "ticketsWithoutPaidOrder",

  -- A paid order whose amount is not the price of its tickets, or not the amount that was held.
  (SELECT count(*)::int FROM orders o JOIN holds h ON h.id = o.hold_id
    WHERE o.event_id = $1 AND o.status = 'paid'
      AND (o.amount_paise <> h.amount_paise
           OR o.amount_paise <> COALESCE((SELECT sum(s.price_paise) FROM tickets t
                                           JOIN event_seats s ON s.id = t.event_seat_id
                                          WHERE t.order_id = o.id), 0))
  ) AS "paidAmountMismatch",

  (SELECT count(DISTINCT a.seat_id)::int FROM promised a JOIN promised b
      ON a.seat_id = b.seat_id AND a.id < b.id AND a.from_ts < b.to_ts AND b.from_ts < a.to_ts
  ) AS "doublePromisedSeats",

  -- Customers who paid and were then refunded because the seat was gone: allowed, but reported.
  (SELECT count(*)::int FROM orders
    WHERE event_id = $1 AND status = 'failed' AND failure_reason IN ('HOLD_LOST', 'SEAT_ALREADY_SOLD')
  ) AS "refundedOrders",

  (SELECT count(*)::int FROM tickets WHERE event_id = $1) AS "ticketsSold",
  (SELECT count(*)::int FROM event_seats WHERE event_id = $1) AS "seatsTotal"`;

type Row = Omit<Invariants, 'pass'> & { ticketsSold: number; seatsTotal: number };

export type EventVerification = Invariants & { ticketsSold: number; seatsTotal: number };

/**
 * Every count must be 0 apart from refundedOrders. The naive strategy double-promises seats on
 * purpose, so for it doublePromisedSeats is reported but not part of `pass`; everything that
 * would mean a customer was oversold still is.
 */
export async function verifyEventWithTotals(
  db: Queryable,
  eventId: string,
  opts: { strategy: StrategyName },
): Promise<EventVerification> {
  const { rows } = await db.query<Row>(INVARIANTS_SQL, [eventId]);
  const { ticketsSold, seatsTotal, ...counts } = rows[0]!;
  const { refundedOrders, doublePromisedSeats, ...mustBeZero } = counts;
  const ignoreDoublePromised = opts.strategy === 'naive';
  const pass = Object.values(mustBeZero).every((n) => n === 0) && (ignoreDoublePromised || doublePromisedSeats === 0);
  return { ...counts, refundedOrders, doublePromisedSeats, pass, ticketsSold, seatsTotal };
}

export async function verifyEvent(db: Queryable, eventId: string, opts: { strategy: StrategyName }): Promise<Invariants> {
  const { ticketsSold: _t, seatsTotal: _s, ...invariants } = await verifyEventWithTotals(db, eventId, opts);
  return invariants;
}
