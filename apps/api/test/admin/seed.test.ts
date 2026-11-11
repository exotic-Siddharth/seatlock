import { SEAT_RADIUS, layoutCapacity, seatPosition, VenueLayoutSchema, type VenueLayout } from '@seatlock/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../../src/scripts/seed';
import { SEED_EVENTS } from '../../src/seed/events';
import { SEED_VENUES } from '../../src/seed/venues';
import { makeCtx, resetState, type TestCtx } from '../helpers';

/** Every seat centre of the layout with the section it belongs to. */
function seatCentres(layout: VenueLayout) {
  return layout.sections.flatMap((section) =>
    Array.from({ length: section.rows }, (_, r) =>
      Array.from({ length: section.seatsPerRow }, (_, n) => ({ section: section.key, ...seatPosition(section, r, n + 1) })),
    ).flat(),
  );
}

describe('seed venue layouts', () => {
  const venue = (slug: string) => SEED_VENUES.find((v) => v.slug === slug)!;

  it.each(SEED_VENUES.map((v) => [v.slug, v] as const))('%s is a valid layout inside its canvas', (_slug, { layout }) => {
    expect(VenueLayoutSchema.safeParse(layout).success).toBe(true);
    const seats = seatCentres(layout);
    for (const { x, y } of seats) {
      expect(x - SEAT_RADIUS).toBeGreaterThanOrEqual(0);
      expect(x + SEAT_RADIUS).toBeLessThanOrEqual(layout.width);
      expect(y - SEAT_RADIUS).toBeGreaterThanOrEqual(0);
      expect(y + SEAT_RADIUS).toBeLessThanOrEqual(layout.height);
    }
    const { stage } = layout;
    const onStage = seats.filter(
      (s) => s.x > stage.x - SEAT_RADIUS && s.x < stage.x + stage.w + SEAT_RADIUS && s.y > stage.y - SEAT_RADIUS && s.y < stage.y + stage.h + SEAT_RADIUS,
    );
    expect(onStage).toHaveLength(0);
  });

  it('has the capacities the spec lists', () => {
    expect(layoutCapacity(venue('lotus-hall').layout)).toBe(480);
    expect(layoutCapacity(venue('riverside-arena').layout)).toBe(2400);
    expect(layoutCapacity(venue('basement-nine').layout)).toBe(120);
    expect(layoutCapacity(venue('bench-stadium').layout)).toBe(10_000);
  });

  it('Riverside Arena has 8 angled sections whose seats never overlap', () => {
    const { layout } = venue('riverside-arena');
    expect(layout.sections).toHaveLength(8);
    expect(new Set(layout.sections.map((s) => s.angle)).size).toBe(8);
    expect(layout.tiers).toHaveLength(4);

    const seats = seatCentres(layout);
    let closest = Infinity;
    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        if (seats[i]!.section === seats[j]!.section) continue;
        closest = Math.min(closest, Math.hypot(seats[i]!.x - seats[j]!.x, seats[i]!.y - seats[j]!.y));
      }
    }
    expect(closest).toBeGreaterThan(2 * SEAT_RADIUS + 3); // clear space between seats of neighbouring sections
  });
});

describe('npm run seed', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await makeCtx();
  });
  beforeEach(() => resetState(ctx));
  afterAll(() => ctx.close());

  const counts = async () => {
    const { rows } = await ctx.deps.db.query<Record<string, number>>(
      `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM venues) AS venues,
              (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM event_seats) AS seats`,
    );
    return rows[0]!;
  };

  it('creates the accounts, venues and 7 events, and a second run changes nothing', async () => {
    const first = await seed(ctx.deps);
    expect(first).toMatchObject({ venues: 4, eventsCreated: 7, eventsExisting: 0 });
    const after = await counts();
    expect(after).toMatchObject({ users: 2, venues: 4, events: 7 });

    const second = await seed(ctx.deps);
    expect(second).toMatchObject({ eventsCreated: 0, eventsExisting: 7 });
    expect(await counts()).toEqual(after);
  });

  it('lists the 7 events with 5 on sale, one opening soon behind a queue and one upcoming', async () => {
    await seed(ctx.deps);
    const res = await request(ctx.app).get('/api/events');
    const items = res.body.items as { title: string; status: string; queueEnabled: boolean; saleOpensAt: string }[];
    expect(items).toHaveLength(7);
    expect(items.filter((e) => e.status === 'on_sale')).toHaveLength(5);
    const upcoming = items.filter((e) => e.status === 'upcoming');
    expect(upcoming).toHaveLength(2);
    const flash = upcoming.find((e) => e.queueEnabled)!;
    expect(Date.parse(flash.saleOpensAt) - Date.now()).toBeLessThanOrEqual(3 * 60_000);
    const later = upcoming.find((e) => !e.queueEnabled)!;
    expect(Date.parse(later.saleOpensAt) - Date.now()).toBeGreaterThan(40 * 3_600_000);
    expect(SEED_EVENTS.every((e) => e.description.split('. ').length >= 2)).toBe(true);
  });

  it('lets the seeded admin sign in with the dev password', async () => {
    await seed(ctx.deps);
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'admin@seatlock.dev', password: 'seatlock-admin-2026' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'admin', name: 'Box Office Admin' });
  });
});
