import { randomUUID } from 'node:crypto';
import { CreateOrderResponseSchema, OrderSchema } from '@seatlock/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getStrategy } from '../../src/booking/strategies';
import { seatKey } from '../../src/booking/strategies/redis';
import { createOnSaleEvent, createUser, makeCtx, resetState, type TestCtx } from '../helpers';
import { expireHold, postHold, postOrder, type Bearer } from './fixtures';

let ctx: TestCtx;
let alice: { user: { id: string }; bearer: Bearer };
let bob: { bearer: Bearer };

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
});
// Fresh buyers per test: the orders rate limit (20/min per user) is real here too.
beforeEach(async () => {
  alice = await createUser(ctx, { name: 'Alice' });
  bob = await createUser(ctx, { name: 'Bob' });
});
afterAll(() => ctx.close());

async function newHold(opts: { holdTtlSeconds?: number; seats?: number } = {}) {
  const { eventId, seatIds } = await createOnSaleEvent(ctx, { holdTtlSeconds: opts.holdTtlSeconds });
  const res = await postHold(ctx, alice.bearer, eventId, seatIds.slice(0, opts.seats ?? 2));
  return { eventId, seatIds, holdId: res.body.hold.id as string };
}

async function orderRows(holdId: string) {
  const { rows } = await ctx.deps.db.query('SELECT id FROM orders WHERE hold_id = $1', [holdId]);
  return rows;
}

describe('POST /api/orders', () => {
  it('creates a pending order and its payment intent', async () => {
    const { holdId } = await newHold();

    const res = await postOrder(ctx, alice.bearer, holdId);

    expect(res.status).toBe(201);
    const body = CreateOrderResponseSchema.parse(res.body);
    expect(body.order).toMatchObject({
      holdId,
      status: 'pending_payment',
      amountPaise: 2 * 249900,
      failureReason: null,
      lastPaymentError: null,
      paidAt: null,
      tickets: [],
      venueName: 'Test Hall',
      eventTitle: 'Test Event',
    });
    expect(body.payment.intentId).toMatch(/^pi_[0-9a-z]{24}$/);
    expect(body.payment).toEqual({ intentId: body.order.paymentIntentId, amountPaise: 2 * 249900 });
  });

  it('replays the same response for the same Idempotency-Key', async () => {
    const { holdId } = await newHold();
    const key = `key-${randomUUID()}`;

    const first = await postOrder(ctx, alice.bearer, holdId, key);
    const second = await postOrder(ctx, alice.bearer, holdId, key);

    expect(second.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(await orderRows(holdId)).toHaveLength(1);
  });

  it('creates one order row for 10 concurrent requests with the same key', async () => {
    const { holdId } = await newHold();
    const key = `key-${randomUUID()}`;

    const responses = await Promise.all(Array.from({ length: 10 }, () => postOrder(ctx, alice.bearer, holdId, key)));

    expect(responses.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(responses.every((r) => r.status === 201 || r.body.error?.code === 'IDEMPOTENCY_IN_PROGRESS')).toBe(true);
    expect(await orderRows(holdId)).toHaveLength(1);
  });

  it('returns the existing order for a second key on the same hold', async () => {
    const { holdId } = await newHold();

    const first = await postOrder(ctx, alice.bearer, holdId);
    const second = await postOrder(ctx, alice.bearer, holdId);

    expect(second.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);
  });

  it('requires an Idempotency-Key', async () => {
    const { holdId } = await newHold();
    const res = await request(ctx.app).post('/api/orders').set(alice.bearer).send({ holdId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('answers 410 HOLD_EXPIRED for a lapsed hold', async () => {
    const { holdId } = await newHold();
    await expireHold(ctx, holdId);

    const res = await postOrder(ctx, alice.bearer, holdId);

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    expect(await orderRows(holdId)).toHaveLength(0);
  });

  it('answers 409 HOLD_NOT_ACTIVE for a released hold and 404 for a stranger', async () => {
    const { holdId } = await newHold();
    const stranger = await postOrder(ctx, bob.bearer, holdId);
    await request(ctx.app).delete(`/api/holds/${holdId}`).set(alice.bearer);
    const released = await postOrder(ctx, alice.bearer, holdId);

    expect(stranger.status).toBe(404);
    expect(released.status).toBe(409);
    expect(released.body.error.code).toBe('HOLD_NOT_ACTIVE');
  });

  it('extends the hold to at least now + 115 s, in the hold and on its seats', async () => {
    const { holdId, seatIds } = await newHold({ holdTtlSeconds: 30 });

    const res = await postOrder(ctx, alice.bearer, holdId);

    const atLeast = Date.now() + 115_000;
    expect(Date.parse(res.body.order.holdExpiresAt)).toBeGreaterThanOrEqual(atLeast);
    const { rows } = await ctx.deps.db.query<{ expires_at: Date; held_until: Date }>(
      `SELECT h.expires_at, s.held_until FROM holds h JOIN event_seats s ON s.hold_id = h.id WHERE h.id = $1`,
      [holdId],
    );
    expect(rows.map((r) => r.held_until.getTime())).toEqual(seatIds.slice(0, 2).map(() => rows[0]!.expires_at.getTime()));
    expect(rows[0]!.expires_at.getTime()).toBeGreaterThanOrEqual(atLeast);
  });

  it("extends a redis-strategy hold's seat gates too", async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx, { holdTtlSeconds: 30 });
    const result = await getStrategy('redis').hold(ctx.deps, { eventId, userId: alice.user.id, seatIds: [seatIds[0]!], ttlSec: 30 });
    if (!result.ok) throw new Error('hold failed');

    await postOrder(ctx, alice.bearer, result.hold.id);

    expect(await ctx.deps.redis.pttl(seatKey(eventId, seatIds[0]!))).toBeGreaterThan(115_000);
  });

  it('never shortens a hold that has more than 120 s left', async () => {
    const { holdId } = await newHold({ holdTtlSeconds: 600 });
    const res = await postOrder(ctx, alice.bearer, holdId);
    expect(Date.parse(res.body.order.holdExpiresAt)).toBeGreaterThan(Date.now() + 590_000);
  });
});

describe('GET /api/orders', () => {
  it('lists my orders, newest first, and shows each one only to its owner', async () => {
    const first = await newHold();
    const firstOrder = await postOrder(ctx, alice.bearer, first.holdId);
    const second = await newHold();
    const secondOrder = await postOrder(ctx, alice.bearer, second.holdId);

    const list = await request(ctx.app).get('/api/orders').set(alice.bearer);
    const one = await request(ctx.app).get(`/api/orders/${firstOrder.body.order.id}`).set(alice.bearer);
    const theirs = await request(ctx.app).get(`/api/orders/${firstOrder.body.order.id}`).set(bob.bearer);
    const bobsList = await request(ctx.app).get('/api/orders').set(bob.bearer);

    const ids = (list.body.items as unknown[]).map((o) => OrderSchema.parse(o).id);
    expect(ids.indexOf(secondOrder.body.order.id)).toBeLessThan(ids.indexOf(firstOrder.body.order.id));
    expect(OrderSchema.parse(one.body.order).id).toBe(firstOrder.body.order.id);
    expect(theirs.status).toBe(404);
    expect(bobsList.body.items).toEqual([]);
  });
});
