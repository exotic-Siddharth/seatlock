import { HoldSchema } from '@seatlock/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seatKey } from '../../src/booking/strategies/redis';
import { sweepOnce } from '../../src/booking/sweeper';
import { signQueueToken } from '../../src/queue/token';
import { createOnSaleEvent, createUser, makeCtx, resetState, type TestCtx } from '../helpers';
import { expireHold, holdStatus, postHold, postOrder, seatRows, type Bearer } from './fixtures';

let ctx: TestCtx;
let alice: { user: { id: string }; bearer: Bearer };
let bob: { user: { id: string }; bearer: Bearer };

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
});
// Fresh buyers per test: the holds rate limit (30/min per user) is real here too.
beforeEach(async () => {
  alice = await createUser(ctx, { name: 'Alice' });
  bob = await createUser(ctx, { name: 'Bob' });
});
afterAll(() => ctx.close());
afterEach(() => {
  vi.restoreAllMocks();
});

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function holdRowCount(eventId: string): Promise<number> {
  const { rows } = await ctx.deps.db.query<{ n: number }>('SELECT count(*) AS n FROM holds WHERE event_id = $1', [eventId]);
  return rows[0]!.n;
}

describe('POST /api/holds', () => {
  it('returns 201 with the hold, its seat labels and the total price', async () => {
    const { eventId, slug, seatIds } = await createOnSaleEvent(ctx, { title: 'Label Check' });
    const [a1, a2] = seatIds as [number, number];
    const silver = seatIds[30]!; // section B starts after section A's 30 seats

    const res = await postHold(ctx, alice.bearer, eventId, [a1, a2, silver]);

    expect(res.status).toBe(201);
    const hold = HoldSchema.parse(res.body.hold);
    expect(hold).toMatchObject({
      eventId,
      eventSlug: slug,
      eventTitle: 'Label Check',
      status: 'active',
      orderId: null,
      amountPaise: 249900 * 2 + 99900,
      seats: [
        { id: a1, label: 'Sec A · Row A · Seat 1', tier: 'gold', pricePaise: 249900 },
        { id: a2, label: 'Sec A · Row A · Seat 2', tier: 'gold', pricePaise: 249900 },
        { id: silver, label: 'Sec B · Row A · Seat 1', tier: 'silver', pricePaise: 99900 },
      ],
    });
    const ttlMs = Date.parse(hold.expiresAt) - Date.parse(hold.serverTime);
    expect(ttlMs).toBeGreaterThan(295_000);
    expect(ttlMs).toBeLessThanOrEqual(301_000);
  });

  it('answers 409 SEATS_UNAVAILABLE with the taken seat ids', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const [a, b] = seatIds as [number, number];
    await postHold(ctx, alice.bearer, eventId, [a]);

    const res = await postHold(ctx, bob.bearer, eventId, [a, b]);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'SEATS_UNAVAILABLE', details: { takenSeatIds: [a] } });
  });

  it('rejects more seats than max_seats_per_order with TOO_MANY_SEATS', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx, { maxSeatsPerOrder: 2 });

    const res = await postHold(ctx, alice.bearer, eventId, seatIds.slice(0, 3));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TOO_MANY_SEATS');
  });

  it('rejects duplicate seat ids', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const [a] = seatIds as [number];

    const res = await postHold(ctx, alice.bearer, eventId, [a, a]);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await holdRowCount(eventId)).toBe(0);
    expect((await seatRows(ctx, [a]))[0]!.status).toBe('available');
  });

  it('rejects seat ids from another event with unknownSeatIds', async () => {
    const mine = await createOnSaleEvent(ctx);
    const other = await createOnSaleEvent(ctx);
    const [a] = mine.seatIds as [number];
    const [foreign] = other.seatIds as [number];

    const res = await postHold(ctx, alice.bearer, mine.eventId, [a, foreign]);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { unknownSeatIds: [foreign] } });
    expect(await holdRowCount(mine.eventId)).toBe(0);
    expect((await seatRows(ctx, [a, foreign])).map((s) => s.status)).toEqual(['available', 'available']);
  });

  it('answers 404 for an unknown event', async () => {
    const res = await postHold(ctx, alice.bearer, '00000000-0000-4000-8000-000000000000', [1]);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects holds before the sale opens with SALE_NOT_OPEN', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx, { saleOpensAt: iso(HOUR) });
    const res = await postHold(ctx, alice.bearer, eventId, [seatIds[0]!]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SALE_NOT_OPEN');
  });

  it('rejects holds once the event has started with SALE_CLOSED', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx, { saleOpensAt: iso(-2 * HOUR), startsAt: iso(-HOUR) });
    const res = await postHold(ctx, alice.bearer, eventId, [seatIds[0]!]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SALE_CLOSED');
  });

  it('rejects X-Bench-Strategy outside bench mode with BENCH_ONLY', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const res = await request(ctx.app)
      .post('/api/holds')
      .set(alice.bearer)
      .set('X-Bench-Strategy', 'naive')
      .send({ eventId, seatIds: [seatIds[0]] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BENCH_ONLY');
    expect(await holdRowCount(eventId)).toBe(0);
  });

  it('requires sign-in', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const res = await request(ctx.app).post('/api/holds').send({ eventId, seatIds: [seatIds[0]] });
    expect(res.status).toBe(401);
  });

  it('allows 30 hold requests per user per minute', async () => {
    // The limit counts in fixed one-minute windows: don't start just before one rolls over.
    const intoWindow = Date.now() % 60_000;
    if (intoWindow > 55_000) await new Promise((resolve) => setTimeout(resolve, 60_100 - intoWindow));
    const attempt = () => request(ctx.app).post('/api/holds').set(alice.bearer).send({});
    const first30 = await Promise.all(Array.from({ length: 30 }, attempt));
    const next = await attempt();

    expect(first30.every((r) => r.status === 400)).toBe(true);
    expect(next.status).toBe(429);
    expect(next.body.error.code).toBe('RATE_LIMITED');
  });

  describe('on a queue-enabled event', () => {
    const withToken = (token: string | undefined, eventId: string, seatId: number) => {
      const req = request(ctx.app).post('/api/holds').set(alice.bearer);
      return (token === undefined ? req : req.set('X-Queue-Token', token)).send({ eventId, seatIds: [seatId] });
    };
    const token = (eventId: string, userId: string, expInMs = 60_000) =>
      signQueueToken(ctx.deps.config.queueTokenSecret, { e: eventId, u: userId, exp: Date.now() + expInMs });

    it('answers 403 QUEUE_REQUIRED without a token', async () => {
      const { eventId, seatIds } = await createOnSaleEvent(ctx, { queueEnabled: true });
      const res = await withToken(undefined, eventId, seatIds[0]!);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('QUEUE_REQUIRED');
    });

    it('answers 403 QUEUE_TOKEN_INVALID for a forged, expired or borrowed token', async () => {
      const { eventId, seatIds } = await createOnSaleEvent(ctx, { queueEnabled: true });
      for (const bad of ['not-a-token', token(eventId, alice.user.id, -1), token(eventId, bob.user.id)]) {
        const res = await withToken(bad, eventId, seatIds[0]!);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('QUEUE_TOKEN_INVALID');
      }
    });

    it('holds with a valid token', async () => {
      const { eventId, seatIds } = await createOnSaleEvent(ctx, { queueEnabled: true });
      const res = await withToken(token(eventId, alice.user.id), eventId, seatIds[0]!);
      expect(res.status).toBe(201);
    });
  });

  it('publishes the held seats and counts the hold in this second’s holds-per-second counter', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const [a, b] = seatIds as [number, number];
    const publish = vi.spyOn(ctx.deps.publisher, 'publish');
    const second = Math.floor(Date.now() / 1000);

    await postHold(ctx, alice.bearer, eventId, [a, b]);

    expect(publish).toHaveBeenCalledWith(eventId, [
      { id: a, st: 'H' },
      { id: b, st: 'H' },
    ]);
    const counts = await Promise.all(
      [second, second + 1].map((s) => ctx.deps.redis.get(`sl:hps:${eventId}:${s}`)),
    );
    expect(counts.reduce((n, c) => n + Number(c ?? 0), 0)).toBe(1);
    const ttl = await ctx.deps.redis.ttl(`sl:hps:${eventId}:${counts[0] ? second : second + 1}`);
    expect(ttl).toBeGreaterThan(100);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('counts every attempt in seatlock_hold_attempts_total by result', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    // Read the numbers straight away: prom-client hands back its live value objects.
    const counts = async () => {
      const { values } = await ctx.deps.metrics.holdAttempts.get();
      const of = (result: string) =>
        values.find((v) => v.labels.strategy === 'conditional' && v.labels.result === result)?.value ?? 0;
      return { ok: of('ok'), conflict: of('conflict') };
    };
    const before = await counts();

    await postHold(ctx, alice.bearer, eventId, [seatIds[0]!]);
    await postHold(ctx, bob.bearer, eventId, [seatIds[0]!]);

    const after = await counts();
    expect({ ok: after.ok - before.ok, conflict: after.conflict - before.conflict }).toEqual({ ok: 1, conflict: 1 });
  });

  it('answers CHECKOUT_IN_PROGRESS for a new hold while an order for the previous one is pending', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const first = await postHold(ctx, alice.bearer, eventId, [seatIds[0]!]);
    await postOrder(ctx, alice.bearer, first.body.hold.id as string);

    const res = await postHold(ctx, alice.bearer, eventId, [seatIds[1]!]);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHECKOUT_IN_PROGRESS');
    expect(await holdStatus(ctx, first.body.hold.id as string)).toBe('active');
    expect((await seatRows(ctx, [seatIds[1]!]))[0]!.status).toBe('available');
  });
});

describe('GET /api/holds/:id', () => {
  it('returns the hold to its owner and 404 to anyone else', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const created = await postHold(ctx, alice.bearer, eventId, [seatIds[0]!]);
    const id = created.body.hold.id as string;

    const mine = await request(ctx.app).get(`/api/holds/${id}`).set(alice.bearer);
    const theirs = await request(ctx.app).get(`/api/holds/${id}`).set(bob.bearer);

    expect(mine.status).toBe(200);
    expect(HoldSchema.parse(mine.body.hold)).toMatchObject({ id, status: 'active', expiresAt: created.body.hold.expiresAt });
    expect(theirs.status).toBe(404);
  });

  it('reports a lapsed hold as expired', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const created = await postHold(ctx, alice.bearer, eventId, [seatIds[0]!]);
    const id = created.body.hold.id as string;
    await ctx.deps.db.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);

    const res = await request(ctx.app).get(`/api/holds/${id}`).set(alice.bearer);

    expect(res.body.hold.status).toBe('expired');
  });
});

describe('DELETE /api/holds/:id', () => {
  it('frees the seats and publishes the changes', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const [a, b] = seatIds as [number, number];
    const created = await postHold(ctx, alice.bearer, eventId, [a, b]);
    const id = created.body.hold.id as string;
    const publish = vi.spyOn(ctx.deps.publisher, 'publish');

    const res = await request(ctx.app).delete(`/api/holds/${id}`).set(alice.bearer);

    expect(res.status).toBe(204);
    expect(await holdStatus(ctx, id)).toBe('released');
    expect((await seatRows(ctx, [a, b])).map((s) => s.status)).toEqual(['available', 'available']);
    expect(publish).toHaveBeenCalledWith(eventId, [
      { id: a, st: 'A' },
      { id: b, st: 'A' },
    ]);
  });

  it('answers 404 to anyone but the owner', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const created = await postHold(ctx, alice.bearer, eventId, [seatIds[0]!]);

    const res = await request(ctx.app).delete(`/api/holds/${created.body.hold.id}`).set(bob.bearer);

    expect(res.status).toBe(404);
    expect(await holdStatus(ctx, created.body.hold.id as string)).toBe('active');
  });

  it('keeps the hold while its order is being paid', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const created = await postHold(ctx, alice.bearer, eventId, [seatIds[0]!]);
    await postOrder(ctx, alice.bearer, created.body.hold.id as string);

    const res = await request(ctx.app).delete(`/api/holds/${created.body.hold.id}`).set(alice.bearer);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHECKOUT_IN_PROGRESS');
  });

  it('answers 204 for a hold the sweeper has already expired, even if its order never got paid', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const created = await postHold(ctx, alice.bearer, eventId, [seatIds[0]!]);
    const id = created.body.hold.id as string;
    await postOrder(ctx, alice.bearer, id);
    await expireHold(ctx, id);
    await sweepOnce(ctx.deps);
    expect(await holdStatus(ctx, id)).toBe('expired');

    const res = await request(ctx.app).delete(`/api/holds/${id}`).set(alice.bearer);

    expect(res.status).toBe(204);
    expect(await holdStatus(ctx, id)).toBe('expired');
  });
});

describe('in bench mode', () => {
  let bench: TestCtx;
  let carol: { bearer: Bearer };

  beforeAll(async () => {
    bench = await makeCtx({ benchMode: true });
    carol = await createUser(bench, { name: 'Carol' });
  });
  afterAll(() => bench.close());

  const benchHold = (strategy: string, eventId: string, seatIds: number[]) =>
    request(bench.app).post('/api/holds').set(carol.bearer).set('X-Bench-Strategy', strategy).send({ eventId, seatIds });

  it('X-Bench-Strategy picks the strategy for the request', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(bench);

    const res = await benchHold('pessimistic', eventId, [seatIds[0]!]);

    expect(res.status).toBe(201);
    const { rows } = await bench.deps.db.query('SELECT strategy FROM holds WHERE id = $1', [res.body.hold.id]);
    expect(rows[0]).toEqual({ strategy: 'pessimistic' });
  });

  it('rejects an unknown strategy name', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(bench);
    const res = await benchHold('optimistic', eventId, [seatIds[0]!]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it("drops the Redis gate keys of the user's previous hold", async () => {
    const { eventId, seatIds } = await createOnSaleEvent(bench);
    const [a, b] = seatIds as [number, number];
    const first = await benchHold('redis', eventId, [a]);
    expect(await bench.deps.redis.get(seatKey(eventId, a))).toBe(first.body.hold.id);

    const second = await benchHold('redis', eventId, [b]);

    expect(second.status).toBe(201);
    expect(await bench.deps.redis.exists(seatKey(eventId, a))).toBe(0);
    expect(await bench.deps.redis.get(seatKey(eventId, b))).toBe(second.body.hold.id);
  });
});
