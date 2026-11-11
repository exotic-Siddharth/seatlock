import { randomUUID } from 'node:crypto';
import type { CreateEventInput } from '@seatlock/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEventWithSeats } from '../../src/events/create';
import { createVenue, makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;
let venueId: string;

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
  ({ venueId } = await createVenue(ctx));
});
afterAll(() => ctx.close());

const input = (overrides: Partial<CreateEventInput> = {}): CreateEventInput => ({
  title: 'Monsoon Static',
  category: 'music',
  venueId,
  startsAt: '2027-01-15T14:30:00.000Z',
  saleOpensAt: '2027-01-01T04:30:00.000Z',
  tierPrices: { gold: 249900, silver: 99900 },
  queueEnabled: false,
  ...overrides,
});

describe('createEventWithSeats', () => {
  it('materialises one available seat per layout seat, priced from its tier', async () => {
    const event = await createEventWithSeats(ctx.deps.db, input({ title: 'Seat Count Check' }));
    expect(event.seatCount).toBe(60);

    const { rows } = await ctx.deps.db.query(
      `SELECT tier, price_paise, count(*) AS seats, bool_and(status = 'available') AS all_available
         FROM event_seats WHERE event_id = $1 GROUP BY tier, price_paise ORDER BY tier`,
      [event.id],
    );
    expect(rows).toEqual([
      { tier: 'gold', price_paise: 249900, seats: 30, all_available: true },
      { tier: 'silver', price_paise: 99900, seats: 30, all_available: true },
    ]);
  });

  it('fills optional fields with the documented defaults', async () => {
    const event = await createEventWithSeats(ctx.deps.db, input({ title: 'Defaults Check' }));
    const { rows } = await ctx.deps.db.query(
      `SELECT subtitle, admit_rate_per_sec, max_seats_per_order, hold_ttl_seconds, poster_hue, listed
         FROM events WHERE id = $1`,
      [event.id],
    );
    expect(rows[0]).toEqual({
      subtitle: '',
      admit_rate_per_sec: 25,
      max_seats_per_order: 6,
      hold_ttl_seconds: 300,
      poster_hue: 260,
      listed: true,
    });
  });

  it('derives the slug from the title and suffixes -2, -3 on collision', async () => {
    const slugs = [];
    for (let i = 0; i < 3; i++) slugs.push((await createEventWithSeats(ctx.deps.db, input())).slug);
    expect(slugs).toEqual(['monsoon-static', 'monsoon-static-2', 'monsoon-static-3']);
  });

  it('rejects tier prices that miss a tier used by the layout, without creating anything', async () => {
    const attempt = createEventWithSeats(ctx.deps.db, input({ title: 'Missing Tier', tierPrices: { gold: 249900 } }));
    await expect(attempt).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { missingTiers: ['silver'] } });
    const { rowCount } = await ctx.deps.db.query(`SELECT 1 FROM events WHERE title = 'Missing Tier'`);
    expect(rowCount).toBe(0);
  });

  it('rejects an unknown venue', async () => {
    await expect(createEventWithSeats(ctx.deps.db, input({ venueId: randomUUID() }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
