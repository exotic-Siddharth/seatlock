import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getQueueCounters, getQueueEvent, joinQueue, simulateCrowd } from '../../src/queue/service';
import { createOnSaleEvent, createUser, createVenue, makeCtx, resetState, type TestCtx } from '../helpers';
import { insertHold, insertPaidOrder, insertUser } from '../events/fixtures';

let ctx: TestCtx;
let admin: { Authorization: string };

beforeAll(async () => {
  ctx = await makeCtx();
});
beforeEach(async () => {
  await resetState(ctx);
  admin = (await createUser(ctx, { role: 'admin', name: 'Box Office Admin' })).bearer;
});
afterAll(() => ctx.close());

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('access control', () => {
  it('rejects guests with 401 and non-admins with 403', async () => {
    const { bearer } = await createUser(ctx);
    for (const [method, path] of [
      ['get', '/api/admin/events'],
      ['get', '/api/admin/venues'],
      ['post', '/api/admin/checkin'],
    ] as const) {
      expect((await request(ctx.app)[method](path)).status).toBe(401);
      const res = await request(ctx.app)[method](path).set(bearer);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });
});

describe('venues and events', () => {
  it('lists venues with their layout', async () => {
    const { venueId } = await createVenue(ctx);
    const res = await request(ctx.app).get('/api/admin/venues').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: venueId, name: 'Test Hall', city: 'Testville', capacity: 60 });
    expect(res.body.items[0].layout.sections).toHaveLength(2);
  });

  it('creates an event and materialises one seat per layout seat', async () => {
    const { venueId, capacity } = await createVenue(ctx);
    const res = await request(ctx.app)
      .post('/api/admin/events')
      .set(admin)
      .send({
        title: 'Opening Night',
        category: 'theatre',
        venueId,
        startsAt: iso(3 * DAY),
        saleOpensAt: iso(DAY),
        tierPrices: { gold: 300000, silver: 150000 },
        queueEnabled: true,
        admitRatePerSec: 10,
      });
    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({
      title: 'Opening Night',
      status: 'upcoming',
      queueEnabled: true,
      priceFromPaise: 150000,
      counts: { total: capacity, available: capacity },
    });
    const { rows } = await ctx.deps.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM event_seats WHERE event_id = $1',
      [res.body.event.id],
    );
    expect(rows[0]!.n).toBe(capacity);
  });

  it('rejects an event whose sale opens after it starts, and a tier without a price', async () => {
    const { venueId } = await createVenue(ctx);
    const base = {
      title: 'Bad',
      category: 'music',
      venueId,
      startsAt: iso(DAY),
      saleOpensAt: iso(2 * DAY),
      tierPrices: { gold: 100, silver: 100 },
      queueEnabled: false,
    };
    const late = await request(ctx.app).post('/api/admin/events').set(admin).send(base);
    expect(late.status).toBe(400);
    const missing = await request(ctx.app)
      .post('/api/admin/events')
      .set(admin)
      .send({ ...base, saleOpensAt: iso(MIN), tierPrices: { gold: 100 } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('lists every event for admins, unlisted ones included, with sold counts and revenue', async () => {
    const shown = await createOnSaleEvent(ctx, { title: 'Shown' });
    await createOnSaleEvent(ctx, { title: 'Hidden', listed: false });
    await insertPaidOrder(ctx, {
      eventId: shown.eventId,
      userId: await insertUser(ctx),
      seatIds: shown.seatIds.slice(0, 2),
      amountPaise: 12345,
    });
    const res = await request(ctx.app).get('/api/admin/events').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const row = res.body.items.find((e: { title: string }) => e.title === 'Shown');
    expect(row).toMatchObject({ listed: true, soldCount: 2, revenuePaise: 12345 });
    expect(res.body.items.find((e: { title: string }) => e.title === 'Hidden').listed).toBe(false);
  });

  it('patches an event and refuses a sale that would open after the start', async () => {
    const { eventId } = await createOnSaleEvent(ctx, { title: 'Before' });
    const ok = await request(ctx.app)
      .patch(`/api/admin/events/${eventId}`)
      .set(admin)
      .send({ title: 'After', listed: false, admitRatePerSec: 40 });
    expect(ok.status).toBe(200);
    expect(ok.body.event).toMatchObject({ title: 'After', listed: false });
    const { rows } = await ctx.deps.db.query('SELECT admit_rate_per_sec FROM events WHERE id = $1', [eventId]);
    expect(rows[0].admit_rate_per_sec).toBe(40);

    const bad = await request(ctx.app)
      .patch(`/api/admin/events/${eventId}`)
      .set(admin)
      .send({ saleOpensAt: iso(30 * DAY) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('404s when patching an unknown event', async () => {
    const res = await request(ctx.app).patch(`/api/admin/events/${randomUUID()}`).set(admin).send({ title: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('dashboard', () => {
  it('shows a real hold in holdsPerSecond, in the key format the hold service writes', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const buyer = await createUser(ctx);
    const hold = await request(ctx.app).post('/api/holds').set(buyer.bearer).send({ eventId, seatIds: [seatIds[0]!] });
    expect(hold.status).toBe(201);

    const res = await request(ctx.app).get(`/api/admin/events/${eventId}/dashboard`).set(admin);
    const perSecond = res.body.holdsPerSecond as number[];
    expect(perSecond).toHaveLength(60);
    expect(perSecond.filter((n) => n > 0)).toEqual([1]);
    expect(perSecond.reduce((x, y) => x + y, 0)).toBe(1);
  });

  it('counts seats, money, holds and recent orders', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const buyer = await insertUser(ctx, 'Priya Buyer');
    await insertPaidOrder(ctx, { eventId, userId: buyer, seatIds: seatIds.slice(0, 3), amountPaise: 7500 });
    await insertHold(ctx, { eventId, userId: await insertUser(ctx), seatIds: seatIds.slice(3, 5) });
    await insertHold(ctx, { eventId, userId: await insertUser(ctx), seatIds: [seatIds[5]!], minutes: -1 });
    const sec = Math.floor(Date.now() / 1000);
    await ctx.deps.redis.set(`sl:hps:${eventId}:${sec}`, '7');
    await ctx.deps.redis.set(`sl:hps:${eventId}:${sec - 3}`, '4');

    const res = await request(ctx.app).get(`/api/admin/events/${eventId}/dashboard`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      counts: { available: 55, held: 2, sold: 3, total: 60 }, // the lapsed hold's seat counts as available
      revenuePaise: 7500,
      ordersPaid: 1,
      ordersFailed: 0,
      ordersPending: 0,
      activeHolds: 1,
      queue: null,
    });
    expect(res.body.event.id).toBe(eventId);
    expect(res.body.holdsPerSecond).toHaveLength(60);
    expect((res.body.holdsPerSecond as number[]).reduce((a, b) => a + b, 0)).toBe(11);
    expect(res.body.recentOrders).toEqual([
      expect.objectContaining({ userName: 'Priya Buyer', seats: 3, amountPaise: 7500, status: 'paid' }),
    ]);
  });

  it('reports the waiting room for a queue event', async () => {
    const { eventId } = await createOnSaleEvent(ctx, { queueEnabled: true });
    const event = (await getQueueEvent(ctx.deps.db, eventId))!;
    await joinQueue(ctx.deps, event, await insertUser(ctx));
    await request(ctx.app).post(`/api/admin/events/${eventId}/simulate-crowd`).set(admin).send({ count: 20 });

    const res = await request(ctx.app).get(`/api/admin/events/${eventId}/dashboard`).set(admin);
    expect(res.body.queue).toEqual({ length: 21, admitted: 0, simulated: 20 });
  });

  it('404s for an unknown event', async () => {
    const res = await request(ctx.app).get(`/api/admin/events/${randomUUID()}/dashboard`).set(admin);
    expect(res.status).toBe(404);
  });
});

describe('demo tools', () => {
  it('reopen-sale moves the sale start and clears the queue', async () => {
    const { eventId } = await createOnSaleEvent(ctx, { queueEnabled: true });
    const event = (await getQueueEvent(ctx.deps.db, eventId))!;
    await joinQueue(ctx.deps, event, await insertUser(ctx));
    expect(await ctx.deps.redis.keys(`sl:q:${eventId}*`)).not.toEqual([]);

    const res = await request(ctx.app)
      .post(`/api/admin/events/${eventId}/reopen-sale`)
      .set(admin)
      .send({ opensInSec: 90 });
    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe('upcoming');
    expect(Date.parse(res.body.event.saleOpensAt) - Date.now()).toBeGreaterThan(80_000);
    expect(Date.parse(res.body.event.saleOpensAt) - Date.now()).toBeLessThanOrEqual(90_000);
    expect(await ctx.deps.redis.keys(`sl:q:${eventId}*`)).toEqual([]);
  });

  it('reopen-sale refuses a time after the event starts', async () => {
    const { eventId } = await createOnSaleEvent(ctx, { startsAt: iso(5 * MIN) });
    const res = await request(ctx.app)
      .post(`/api/admin/events/${eventId}/reopen-sale`)
      .set(admin)
      .send({ opensInSec: 3600 });
    expect(res.status).toBe(400);
  });

  it('simulate-crowd adds the requested bots and returns the queue length', async () => {
    const { eventId } = await createOnSaleEvent(ctx, { queueEnabled: true });
    const res = await request(ctx.app)
      .post(`/api/admin/events/${eventId}/simulate-crowd`)
      .set(admin)
      .send({ count: 250 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queueLength: 250 });
  });

  it('simulate-crowd refuses an event without a queue and an oversized crowd', async () => {
    const plain = await createOnSaleEvent(ctx);
    const noQueue = await request(ctx.app)
      .post(`/api/admin/events/${plain.eventId}/simulate-crowd`)
      .set(admin)
      .send({ count: 5 });
    expect(noQueue.status).toBe(400);
    const { eventId } = await createOnSaleEvent(ctx, { queueEnabled: true });
    const tooMany = await request(ctx.app)
      .post(`/api/admin/events/${eventId}/simulate-crowd`)
      .set(admin)
      .send({ count: 5001 });
    expect(tooMany.status).toBe(400);
  });
});

describe('check-in', () => {
  it('checks a ticket in once, then reports it as already checked in', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx, { title: 'Door Test' });
    const { ticketCodes } = await insertPaidOrder(ctx, { eventId, userId: await insertUser(ctx), seatIds: [seatIds[0]!] });
    const code = ticketCodes[0]!;

    const first = await request(ctx.app).post('/api/admin/checkin').set(admin).send({ code: code.toLowerCase() });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      alreadyCheckedIn: false,
      eventTitle: 'Door Test',
      seatLabel: 'Sec A · Row A · Seat 1',
    });
    expect(first.body.ticket).toMatchObject({ code, tier: 'gold' });
    expect(first.body.ticket.checkedInAt).not.toBeNull();

    const second = await request(ctx.app).post('/api/admin/checkin').set(admin).send({ code });
    expect(second.status).toBe(200);
    expect(second.body.alreadyCheckedIn).toBe(true);
    expect(second.body.ticket.checkedInAt).toBe(first.body.ticket.checkedInAt);
  });

  it('answers 404 for an unknown code', async () => {
    const res = await request(ctx.app).post('/api/admin/checkin').set(admin).send({ code: 'SL-NOSUCHTICKET' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('bench-reset', () => {
  it('is a 404 unless BENCH_MODE is on', async () => {
    const { eventId } = await createOnSaleEvent(ctx);
    const res = await request(ctx.app).post(`/api/admin/events/${eventId}/bench-reset`).set(admin);
    expect(res.status).toBe(404);
  });

  it('with BENCH_MODE on, frees the event and answers 204', async () => {
    const bench = await makeCtx({ benchMode: true });
    try {
      const { eventId, seatIds } = await createOnSaleEvent(bench, { queueEnabled: true });
      const userId = await insertUser(bench);
      await insertHold(bench, { eventId, userId, seatIds: [seatIds[0]!] });
      await insertPaidOrder(bench, { eventId, userId, seatIds: [seatIds[1]!] });
      await simulateCrowd(bench.deps, eventId, 3);

      const res = await request(bench.app).post(`/api/admin/events/${eventId}/bench-reset`).set(admin);
      expect(res.status).toBe(204);

      const seats = await bench.deps.db.query("SELECT 1 FROM event_seats WHERE event_id = $1 AND status <> 'available'", [eventId]);
      expect(seats.rowCount).toBe(0);
      for (const table of ['holds', 'orders', 'tickets']) {
        const { rows } = await bench.deps.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0]!.n).toBe(0);
      }
      expect(await getQueueCounters(bench.deps, eventId)).toEqual({ length: 0, admitted: 0, simulated: 0 });
    } finally {
      await bench.close();
    }
  });
});
