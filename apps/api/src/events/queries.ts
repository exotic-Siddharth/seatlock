import type { AdminEventRow, Category, EventDetail, EventStatus, EventSummary, VenueLayout } from '@seatlock/shared';
import { z } from 'zod';
import type { Queryable } from '../db';
import { AVAILABLE_SQL } from './status';

/** One event with its venue and live seat counts: everything the event DTOs are built from. */
export type EventRow = {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  category: Category;
  poster_hue: number;
  starts_at: Date;
  sale_opens_at: Date;
  queue_enabled: boolean;
  admit_rate_per_sec: number;
  max_seats_per_order: number;
  hold_ttl_seconds: number;
  tier_prices: Record<string, number>;
  listed: boolean;
  venue_name: string;
  venue_city: string;
  layout: VenueLayout;
  total: number;
  available: number;
  sold: number;
  price_from: number;
  revenue: number;
  status: EventStatus;
  server_time: Date;
};

// Status is decided in SQL so it uses the database clock, like the seat availability does.
// A fully held event is still on sale: holds lapse. Only sold seats make it sold out.
const SELECT_EVENTS = `
  SELECT e.id, e.slug, e.title, e.subtitle, e.description, e.category, e.poster_hue, e.starts_at,
         e.sale_opens_at, e.queue_enabled, e.admit_rate_per_sec, e.max_seats_per_order,
         e.hold_ttl_seconds, e.tier_prices, e.listed,
         v.name AS venue_name, v.city AS venue_city, v.layout,
         c.total, c.available, c.sold,
         (SELECT min(value::int) FROM jsonb_each_text(e.tier_prices)) AS price_from,
         (SELECT coalesce(sum(o.amount_paise), 0) FROM orders o WHERE o.event_id = e.id AND o.status = 'paid') AS revenue,
         CASE WHEN now() >= e.starts_at THEN 'ended'
              WHEN now() < e.sale_opens_at THEN 'upcoming'
              WHEN c.total > 0 AND c.sold = c.total THEN 'sold_out'
              ELSE 'on_sale' END AS status,
         now() AS server_time
  FROM events e
  JOIN venues v ON v.id = e.venue_id
  CROSS JOIN LATERAL (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE ${AVAILABLE_SQL('s')}) AS available,
           count(*) FILTER (WHERE s.status = 'sold') AS sold
    FROM event_seats s WHERE s.event_id = e.id
  ) c`;

const ORDER = 'ORDER BY e.starts_at, e.created_at';

export function isUuid(value: string): boolean {
  return z.string().uuid().safeParse(value).success;
}

export async function findEventById(db: Queryable, id: string): Promise<EventRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query<EventRow>(`${SELECT_EVENTS} WHERE e.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findEventBySlug(db: Queryable, slug: string): Promise<EventRow | null> {
  const { rows } = await db.query<EventRow>(`${SELECT_EVENTS} WHERE e.slug = $1`, [slug]);
  return rows[0] ?? null;
}

/** Listed events by start time, optionally of one category. */
export async function listPublicEvents(db: Queryable, category?: Category): Promise<EventRow[]> {
  const { rows } = await db.query<EventRow>(
    `${SELECT_EVENTS} WHERE e.listed AND ($1::text IS NULL OR e.category = $1) ${ORDER}`,
    [category ?? null],
  );
  return rows;
}

export async function listAllEvents(db: Queryable): Promise<EventRow[]> {
  const { rows } = await db.query<EventRow>(`${SELECT_EVENTS} ${ORDER}`);
  return rows;
}

export async function eventExists(db: Queryable, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await db.query('SELECT 1 FROM events WHERE id = $1', [id]);
  return rowCount === 1;
}

/** Effective seat counts: a lapsed hold counts as available. */
export async function seatCounts(
  db: Queryable,
  eventId: string,
): Promise<{ available: number; held: number; sold: number; total: number }> {
  const { rows } = await db.query<{ held: number; sold: number; total: number }>(
    `SELECT count(*) FILTER (WHERE status = 'held' AND held_until > now()) AS held,
            count(*) FILTER (WHERE status = 'sold') AS sold,
            count(*) AS total
     FROM event_seats WHERE event_id = $1`,
    [eventId],
  );
  const { held, sold, total } = rows[0]!;
  return { available: total - held - sold, held, sold, total };
}

export function toSummary(row: EventRow): EventSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    category: row.category,
    posterHue: row.poster_hue,
    startsAt: row.starts_at.toISOString(),
    saleOpensAt: row.sale_opens_at.toISOString(),
    venue: { name: row.venue_name, city: row.venue_city },
    status: row.status,
    priceFromPaise: row.price_from,
    counts: { total: row.total, available: row.available },
    queueEnabled: row.queue_enabled,
  };
}

export function toDetail(row: EventRow): EventDetail {
  return {
    ...toSummary(row),
    description: row.description,
    maxSeatsPerOrder: row.max_seats_per_order,
    holdTtlSeconds: row.hold_ttl_seconds,
    admitRatePerSec: row.admit_rate_per_sec,
    tierPrices: row.tier_prices,
    layout: row.layout,
    serverTime: row.server_time.toISOString(),
  };
}

export function toAdminRow(row: EventRow): AdminEventRow {
  return { ...toSummary(row), listed: row.listed, soldCount: row.sold, revenuePaise: row.revenue };
}
