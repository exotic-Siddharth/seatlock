import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createParser } from 'eventsource-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOnSaleEvent, createUser, createVenue, makeCtx, resetState, type TestCtx } from '../helpers';
import { insertHold, insertPaidOrder, insertUser } from './fixtures';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await makeCtx();
});
beforeEach(() => resetState(ctx));
afterAll(() => ctx.close());

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('GET /api/events', () => {
  it('lists listed events by start time and leaves out unlisted ones', async () => {
    const venue = await createVenue(ctx);
    const late = await createOnSaleEvent(ctx, { title: 'Late Show', venueId: venue.venueId, startsAt: iso(48 * HOUR) });
    const soon = await createOnSaleEvent(ctx, { title: 'Soon Show', venueId: venue.venueId, startsAt: iso(24 * HOUR) });
    await createOnSaleEvent(ctx, { title: 'Hidden Show', venueId: venue.venueId, listed: false });

    const res = await request(ctx.app).get('/api/events');
    expect(res.status).toBe(200);
    expect(res.body.items.map((e: { slug: string }) => e.slug)).toEqual([soon.slug, late.slug]);
    expect(res.body.items[0]).toMatchObject({
      title: 'Soon Show',
      venue: { name: 'Test Hall', city: 'Testville' },
      counts: { total: 60, available: 60 },
      priceFromPaise: 99900,
      queueEnabled: false,
    });
  });

  it('filters by category', async () => {
    const venue = await createVenue(ctx);
    await createOnSaleEvent(ctx, { title: 'Gig', category: 'music', venueId: venue.venueId });
    const laughs = await createOnSaleEvent(ctx, { title: 'Laughs', category: 'comedy', venueId: venue.venueId });
    const res = await request(ctx.app).get('/api/events?category=comedy');
    expect(res.body.items.map((e: { slug: string }) => e.slug)).toEqual([laughs.slug]);
  });

  it('rejects an unknown category', async () => {
    const res = await request(ctx.app).get('/api/events?category=opera');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('computes upcoming, on_sale, sold_out and ended', async () => {
    const venue = await createVenue(ctx);
    const make = (title: string, extra: object = {}) => createOnSaleEvent(ctx, { title, venueId: venue.venueId, ...extra });
    const upcoming = await make('Upcoming', { saleOpensAt: iso(2 * HOUR), startsAt: iso(48 * HOUR) });
    const onSale = await make('On Sale');
    const soldOut = await make('Sold Out');
    const ended = await make('Ended');

    await insertPaidOrder(ctx, { eventId: soldOut.eventId, userId: await insertUser(ctx), seatIds: soldOut.seatIds });
    await ctx.deps.db.query(
      `UPDATE events SET sale_opens_at = now() - interval '3 days', starts_at = now() - interval '1 hour' WHERE id = $1`,
      [ended.eventId],
    );

    const res = await request(ctx.app).get('/api/events');
    const statusOf = (slug: string) => res.body.items.find((e: { slug: string }) => e.slug === slug).status as string;
    expect(statusOf(upcoming.slug)).toBe('upcoming');
    expect(statusOf(onSale.slug)).toBe('on_sale');
    expect(statusOf(soldOut.slug)).toBe('sold_out');
    expect(statusOf(ended.slug)).toBe('ended');
  });

  it('a fully held event is still on sale, because holds lapse', async () => {
    const { slug, eventId, seatIds } = await createOnSaleEvent(ctx);
    await insertHold(ctx, { eventId, userId: await insertUser(ctx), seatIds });
    const res = await request(ctx.app).get('/api/events');
    expect(res.body.items.find((e: { slug: string }) => e.slug === slug)).toMatchObject({
      status: 'on_sale',
      counts: { total: 60, available: 0 },
    });
  });

  it('priceFromPaise is the cheapest tier price', async () => {
    await createOnSaleEvent(ctx, { tierPrices: { gold: 500000, silver: 120000 } });
    const res = await request(ctx.app).get('/api/events');
    expect(res.body.items[0].priceFromPaise).toBe(120000);
  });
});

describe('GET /api/events/:slug', () => {
  it('returns the detail with layout and serverTime', async () => {
    const { slug } = await createOnSaleEvent(ctx, { description: 'A fine evening.', maxSeatsPerOrder: 4 });
    const res = await request(ctx.app).get(`/api/events/${slug}`);
    expect(res.status).toBe(200);
    const { event } = res.body;
    expect(event).toMatchObject({
      slug,
      description: 'A fine evening.',
      maxSeatsPerOrder: 4,
      holdTtlSeconds: 300,
      admitRatePerSec: 25,
      tierPrices: { gold: 249900, silver: 99900 },
    });
    expect(event.layout.sections).toHaveLength(2);
    expect(Math.abs(Date.parse(event.serverTime) - Date.now())).toBeLessThan(5_000);
  });

  it('serves unlisted events by slug', async () => {
    const { slug } = await createOnSaleEvent(ctx, { listed: false });
    expect((await request(ctx.app).get(`/api/events/${slug}`)).status).toBe(200);
  });

  it('404s for an unknown slug', async () => {
    const res = await request(ctx.app).get('/api/events/no-such-event');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/events/:id/seats', () => {
  it('lists every seat as a tuple with its effective status', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const [sold, held, lapsed] = seatIds as [number, number, number];
    const userId = await insertUser(ctx);
    await insertPaidOrder(ctx, { eventId, userId, seatIds: [sold] });
    await insertHold(ctx, { eventId, userId, seatIds: [held] });
    await insertHold(ctx, { eventId, userId, seatIds: [lapsed], minutes: -1 });

    const res = await request(ctx.app).get(`/api/events/${eventId}/seats`);
    expect(res.status).toBe(200);
    expect(res.body.eventId).toBe(eventId);
    expect(res.body.seats).toHaveLength(60);
    expect(res.body.myHold).toBeNull();
    const byId = new Map<number, unknown[]>(res.body.seats.map((s: unknown[]) => [s[0] as number, s]));
    expect(byId.get(seatIds[3]!)).toEqual([seatIds[3], 'A', 'A', 4, 'gold', 'A']);
    expect(byId.get(sold)![5]).toBe('S');
    expect(byId.get(held)![5]).toBe('H');
    expect(byId.get(lapsed)![5]).toBe('A'); // the hold lapsed, so the seat is lazily available
    expect(byId.get(seatIds[59]!)).toEqual([seatIds[59], 'B', 'C', 10, 'silver', 'A']);
  });

  it("returns the caller's active hold as myHold, and null to everyone else", async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const me = await createUser(ctx);
    const other = await createUser(ctx);
    const holdId = await insertHold(ctx, { eventId, userId: me.user.id, seatIds: [seatIds[0]!, seatIds[1]!] });

    const mine = await request(ctx.app).get(`/api/events/${eventId}/seats`).set(me.bearer);
    expect(mine.status).toBe(200);
    expect(mine.body.myHold).toMatchObject({ id: holdId, seatIds: [seatIds[0], seatIds[1]] });
    expect(Date.parse(mine.body.myHold.expiresAt)).toBeGreaterThan(Date.now());

    const theirs = await request(ctx.app).get(`/api/events/${eventId}/seats`).set(other.bearer);
    expect(theirs.body.myHold).toBeNull();
  });

  it('404s for an unknown event, including a malformed id', async () => {
    expect((await request(ctx.app).get(`/api/events/${randomUUID()}/seats`)).status).toBe(404);
    expect((await request(ctx.app).get('/api/events/not-a-uuid/seats')).status).toBe(404);
  });
});

describe('GET /api/events/:id/stream', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer(ctx.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('streams a published seat change as an SSE event', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const abort = new AbortController();
    const res = await fetch(`${base}/api/events/${eventId}/stream`, { signal: abort.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const seen: { event?: string; data: string }[] = [];
    const parser = createParser({ onEvent: (e) => seen.push({ event: e.event, data: e.data }) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    })().catch(() => undefined);

    await ctx.deps.publisher.publish(eventId, [{ id: seatIds[0]!, st: 'H' }]);
    await expect.poll(() => seen.find((e) => e.event === 'seats'), { timeout: 5_000 }).toBeDefined();
    expect(JSON.parse(seen.find((e) => e.event === 'seats')!.data)).toEqual({
      changes: [{ id: seatIds[0], st: 'H' }],
    });
    abort.abort();
    await pump;
  });

  it('404s for an unknown event', async () => {
    const res = await fetch(`${base}/api/events/${randomUUID()}/stream`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/stats', () => {
  it('counts sold tickets, events on sale and active holds', async () => {
    const venue = await createVenue(ctx);
    const { eventId, seatIds } = await createOnSaleEvent(ctx, { venueId: venue.venueId });
    await createOnSaleEvent(ctx, {
      title: 'Not Yet',
      venueId: venue.venueId,
      saleOpensAt: iso(HOUR),
      startsAt: iso(48 * HOUR),
    });
    const userId = await insertUser(ctx);
    await insertPaidOrder(ctx, { eventId, userId, seatIds: [seatIds[0]!, seatIds[1]!] });
    await insertHold(ctx, { eventId, userId, seatIds: [seatIds[2]!] });

    const res = await request(ctx.app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ticketsSold: 2, eventsOnSale: 1, activeHolds: 1 });
  });

  it('leaves out unlisted (bench) events, which share the stack database with the demo', async () => {
    const venue = await createVenue(ctx);
    const listed = await createOnSaleEvent(ctx, { venueId: venue.venueId });
    const bench = await createOnSaleEvent(ctx, { title: 'Bench Hot', venueId: venue.venueId, listed: false });
    const userId = await insertUser(ctx);
    await insertPaidOrder(ctx, { eventId: listed.eventId, userId, seatIds: [listed.seatIds[0]!] });
    await insertPaidOrder(ctx, { eventId: bench.eventId, userId, seatIds: [bench.seatIds[0]!, bench.seatIds[1]!] });
    await insertHold(ctx, { eventId: bench.eventId, userId, seatIds: [bench.seatIds[2]!] });

    const res = await request(ctx.app).get('/api/stats');
    expect(res.body).toEqual({ ticketsSold: 1, eventsOnSale: 1, activeHolds: 0 });
  });
});
