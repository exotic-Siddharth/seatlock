import { seatLabel, type Hold, type HoldStatus, type Order, type OrderStatus, type VenueLayout } from '@seatlock/shared';
import type { Queryable } from '../db';

/** The fixed facts about a seat that a hold or ticket shows. */
export type SeatInfo = {
  id: number;
  sectionKey: string;
  rowLabel: string;
  seatNumber: number;
  tier: string;
  pricePaise: number;
};

export async function loadSeats(db: Queryable, eventId: string, seatIds: number[]): Promise<SeatInfo[]> {
  const { rows } = await db.query<SeatInfo>(
    `SELECT id, section_key AS "sectionKey", row_label AS "rowLabel", seat_number AS "seatNumber",
            tier, price_paise AS "pricePaise"
       FROM event_seats WHERE event_id = $1 AND id = ANY($2) ORDER BY id`,
    [eventId, seatIds],
  );
  return rows;
}

/** "Sec B · Row C · Seat 12", using the section's display name from the venue layout. */
function labelOf(layout: VenueLayout, seat: Omit<SeatInfo, 'id' | 'pricePaise'>): string {
  const section = layout.sections.find((s) => s.key === seat.sectionKey);
  return seatLabel(section?.name ?? seat.sectionKey, seat.rowLabel, seat.seatNumber);
}

type HoldFacts = {
  id: string;
  eventId: string;
  amountPaise: number;
  expiresAt: Date;
  status: HoldStatus;
  orderId: string | null;
};
type EventFacts = { slug: string; title: string; layout: VenueLayout };

export function toHold(hold: HoldFacts, event: EventFacts, seats: SeatInfo[]): Hold {
  return {
    id: hold.id,
    eventId: hold.eventId,
    eventSlug: event.slug,
    eventTitle: event.title,
    seats: seats.map((s) => ({ id: s.id, label: labelOf(event.layout, s), tier: s.tier, pricePaise: s.pricePaise })),
    amountPaise: hold.amountPaise,
    expiresAt: hold.expiresAt.toISOString(),
    status: hold.status,
    serverTime: new Date().toISOString(),
    orderId: hold.orderId,
  };
}

/** A hold in its API shape, plus its owner. A lapsed active hold reads as 'expired' (holds expire lazily). */
export async function readHold(db: Queryable, holdId: string): Promise<{ userId: string; hold: Hold } | null> {
  const { rows } = await db.query<HoldFacts & EventFacts & { userId: string; seatIds: number[] }>(
    `SELECT h.id, h.user_id AS "userId", h.event_id AS "eventId", h.seat_ids AS "seatIds",
            h.amount_paise AS "amountPaise", h.expires_at AS "expiresAt",
            CASE WHEN h.status = 'active' AND h.expires_at <= now() THEN 'expired' ELSE h.status::text END AS status,
            e.slug, e.title, v.layout, o.id AS "orderId"
       FROM holds h
       JOIN events e ON e.id = h.event_id
       JOIN venues v ON v.id = e.venue_id
       LEFT JOIN orders o ON o.hold_id = h.id
      WHERE h.id = $1`,
    [holdId],
  );
  const row = rows[0];
  if (!row) return null;
  const seats = await loadSeats(db, row.eventId, row.seatIds);
  return { userId: row.userId, hold: toHold(row, { slug: row.slug, title: row.title, layout: row.layout }, seats) };
}

type OrderRow = {
  id: string;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  eventStartsAt: Date;
  venueName: string;
  layout: VenueLayout;
  status: OrderStatus;
  failureReason: string | null;
  lastPaymentError: string | null;
  amountPaise: number;
  createdAt: Date;
  paidAt: Date | null;
  holdId: string;
  holdExpiresAt: Date;
  paymentIntentId: string;
};

type TicketRow = Omit<SeatInfo, 'id'> & { id: string; orderId: string; code: string; checkedInAt: Date | null };

/** The user's orders with their tickets, newest first; only `orderId` if given. */
export async function readOrders(db: Queryable, userId: string, orderId: string | null = null): Promise<Order[]> {
  const { rows } = await db.query<OrderRow>(
    `SELECT o.id, o.event_id AS "eventId", e.slug AS "eventSlug", e.title AS "eventTitle",
            e.starts_at AS "eventStartsAt", v.name AS "venueName", v.layout, o.status,
            o.failure_reason AS "failureReason", pi.failure_code AS "lastPaymentError",
            o.amount_paise AS "amountPaise", o.created_at AS "createdAt", o.paid_at AS "paidAt",
            o.hold_id AS "holdId", h.expires_at AS "holdExpiresAt", pi.id AS "paymentIntentId"
       FROM orders o
       JOIN events e ON e.id = o.event_id
       JOIN venues v ON v.id = e.venue_id
       JOIN holds h ON h.id = o.hold_id
       JOIN payment_intents pi ON pi.order_id = o.id
      WHERE o.user_id = $1 AND ($2::uuid IS NULL OR o.id = $2)
      ORDER BY o.created_at DESC, o.id`,
    [userId, orderId],
  );
  if (rows.length === 0) return [];

  const tickets = await db.query<TicketRow>(
    `SELECT t.id, t.order_id AS "orderId", t.code, t.checked_in_at AS "checkedInAt",
            s.section_key AS "sectionKey", s.row_label AS "rowLabel", s.seat_number AS "seatNumber",
            s.tier, s.price_paise AS "pricePaise"
       FROM tickets t JOIN event_seats s ON s.id = t.event_seat_id
      WHERE t.order_id = ANY($1)
      ORDER BY s.id`,
    [rows.map((r) => r.id)],
  );

  return rows.map(({ layout, ...o }) => ({
    ...o,
    eventStartsAt: o.eventStartsAt.toISOString(),
    createdAt: o.createdAt.toISOString(),
    paidAt: o.paidAt?.toISOString() ?? null,
    holdExpiresAt: o.holdExpiresAt.toISOString(),
    tickets: tickets.rows
      .filter((t) => t.orderId === o.id)
      .map((t) => ({
        id: t.id,
        code: t.code,
        seatLabel: labelOf(layout, t),
        tier: t.tier,
        pricePaise: t.pricePaise,
        checkedInAt: t.checkedInAt?.toISOString() ?? null,
      })),
  }));
}
