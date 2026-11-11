import { EVENT_DEFAULTS, materializeLayout, type CreateEventInput, type VenueLayout } from '@seatlock/shared';
import type pg from 'pg';
import { withTx } from '../db';
import { AppError } from '../errors';

/** "Monsoon Static: Live!" -> "monsoon-static-live" */
function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'event';
}

/** Inserts the event under the first free slug: base, base-2, base-3, ... */
async function insertEvent(c: pg.PoolClient, input: CreateEventInput): Promise<{ id: string; slug: string }> {
  const base = slugify(input.title);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO events (slug, title, subtitle, description, category, venue_id, starts_at, sale_opens_at,
                           tier_prices, queue_enabled, admit_rate_per_sec, max_seats_per_order,
                           hold_ttl_seconds, poster_hue, listed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [
        slug,
        input.title,
        input.subtitle ?? EVENT_DEFAULTS.subtitle,
        input.description ?? EVENT_DEFAULTS.description,
        input.category,
        input.venueId,
        input.startsAt,
        input.saleOpensAt,
        JSON.stringify(input.tierPrices),
        input.queueEnabled,
        input.admitRatePerSec ?? EVENT_DEFAULTS.admitRatePerSec,
        input.maxSeatsPerOrder ?? EVENT_DEFAULTS.maxSeatsPerOrder,
        input.holdTtlSeconds ?? EVENT_DEFAULTS.holdTtlSeconds,
        input.posterHue ?? EVENT_DEFAULTS.posterHue,
        input.listed ?? EVENT_DEFAULTS.listed,
      ],
    );
    if (rows[0]) return { id: rows[0].id, slug };
  }
}

/**
 * Creates an event and materialises one `event_seats` row per seat in its venue's layout,
 * priced from `tierPrices[section.tier]`, in a single bulk INSERT ... SELECT FROM unnest.
 * Throws NOT_FOUND for an unknown venue and VALIDATION_FAILED when a layout tier has no price.
 */
export async function createEventWithSeats(
  db: pg.Pool,
  input: CreateEventInput,
): Promise<{ id: string; slug: string; seatCount: number }> {
  return withTx(db, async (c) => {
    const venue = await c.query<{ layout: VenueLayout }>('SELECT layout FROM venues WHERE id = $1', [input.venueId]);
    const layout = venue.rows[0]?.layout;
    if (!layout) throw new AppError('NOT_FOUND', 'Venue not found');

    const usedTiers = [...new Set(layout.sections.map((s) => s.tier))];
    const missingTiers = usedTiers.filter((tier) => !Object.hasOwn(input.tierPrices, tier));
    if (missingTiers.length > 0) {
      throw new AppError('VALIDATION_FAILED', `Set a price for every tier: missing ${missingTiers.join(', ')}`, {
        missingTiers,
      });
    }

    const event = await insertEvent(c, input);
    const seats = materializeLayout(layout);
    await c.query(
      `INSERT INTO event_seats (event_id, section_key, row_label, seat_number, tier, price_paise)
       SELECT $1::uuid, * FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::int[])`,
      [
        event.id,
        seats.map((s) => s.sectionKey),
        seats.map((s) => s.rowLabel),
        seats.map((s) => s.seatNumber),
        seats.map((s) => s.tier),
        seats.map((s) => input.tierPrices[s.tier]),
      ],
    );
    return { ...event, seatCount: seats.length };
  });
}
