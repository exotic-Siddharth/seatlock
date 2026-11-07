import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getStrategy } from '../../src/booking/strategies';
import { seatKey } from '../../src/booking/strategies/redis';
import { createOnSaleEvent, createUser, makeCtx, resetState, type TestCtx } from '../helpers';
import { expireHold, holdAndOrder, holdStatus, postHold, postOrder, seatRows, sendWebhook, type Bearer } from '../booking/fixtures';

let ctx: TestCtx;
let alice: { user: { id: string }; bearer: Bearer };
let bob: { user: { id: string }; bearer: Bearer };

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
  alice = await createUser(ctx, { name: 'Alice' });
  bob = await createUser(ctx, { name: 'Bob' });
});
afterAll(() => ctx.close());
afterEach(() => {
  vi.restoreAllMocks();
});

const succeeded = (intentId: string, id?: string) => ({ type: 'payment_intent.succeeded' as const, intentId, id });

async function order(bearer: Bearer, orderId: string) {
  const res = await request(ctx.app).get(`/api/orders/${orderId}`).set(bearer);
  return res.body.order;
}

async function intent(intentId: string) {
  const { rows } = await ctx.deps.db.query('SELECT status, failure_code FROM payment_intents WHERE id = $1', [intentId]);
  return rows[0];
}

async function ticketCount(seatIds: number[]): Promise<number> {
  const { rows } = await ctx.deps.db.query<{ n: number }>(
    'SELECT count(*) AS n FROM tickets WHERE event_seat_id = ANY($1)',
    [seatIds],
  );
  return rows[0]!.n;
}

describe('POST /api/webhooks/mockpay', () => {
  it('on a valid success: pays the order, issues one ticket per seat and sells the seats', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const seats = seatIds.slice(0, 2);
    const { holdId, orderId, intentId } = await holdAndOrder(ctx, alice.bearer, eventId, seats);
    const publish = vi.spyOn(ctx.deps.publisher, 'publish');

    const res = await sendWebhook(ctx, succeeded(intentId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const paid = await order(alice.bearer, orderId);
    expect(paid).toMatchObject({ status: 'paid', failureReason: null, lastPaymentError: null });
    expect(paid.paidAt).not.toBeNull();
    expect(paid.tickets).toHaveLength(2);
    for (const ticket of paid.tickets) expect(ticket.code).toMatch(/^SL-[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(paid.tickets.map((t: { seatLabel: string }) => t.seatLabel)).toEqual([
      'Sec A · Row A · Seat 1',
      'Sec A · Row A · Seat 2',
    ]);
    expect(await seatRows(ctx, seats)).toEqual(seats.map((id) => ({ id, status: 'sold', hold_id: null, order_id: orderId })));
    expect(await holdStatus(ctx, holdId)).toBe('converted');
    expect(await intent(intentId)).toEqual({ status: 'succeeded', failure_code: null });
    expect(publish).toHaveBeenCalledWith(eventId, seats.map((id) => ({ id, st: 'S' })));
  });

  it('leaves the seat gates of a redis-strategy sale at "sold" with no expiry', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const [a] = seatIds as [number];
    const held = await getStrategy('redis').hold(ctx.deps, { eventId, userId: alice.user.id, seatIds: [a], ttlSec: 300 });
    if (!held.ok) throw new Error('hold failed');
    const placed = await postOrder(ctx, alice.bearer, held.hold.id);

    await sendWebhook(ctx, succeeded(placed.body.payment.intentId as string));

    expect(await ctx.deps.redis.get(seatKey(eventId, a))).toBe('sold');
    expect(await ctx.deps.redis.pttl(seatKey(eventId, a))).toBe(-1);
  });

  it('processes a duplicate event id only once', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const seats = seatIds.slice(0, 2);
    const { intentId } = await holdAndOrder(ctx, alice.bearer, eventId, seats);
    const eventId1 = `evt_${randomUUID()}`;

    const responses = await Promise.all([1, 2, 3].map(() => sendWebhook(ctx, succeeded(intentId, eventId1))));
    const replay = await sendWebhook(ctx, succeeded(intentId, eventId1));

    expect([...responses, replay].map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await ticketCount(seats)).toBe(2);
  });

  it('rejects a bad, malformed or missing signature with 400 BAD_SIGNATURE', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const { orderId, intentId } = await holdAndOrder(ctx, alice.bearer, eventId, [seatIds[0]!]);

    const wrongSecret = await sendWebhook(ctx, succeeded(intentId), { secret: 'not-the-secret-not-the-secret-123' });
    const malformed = await sendWebhook(ctx, succeeded(intentId), { signature: 't=abc,v1=zz' });
    const missing = await request(ctx.app)
      .post('/api/webhooks/mockpay')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded', data: { intentId } }));

    for (const res of [wrongSecret, malformed, missing]) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_SIGNATURE');
    }
    expect((await order(alice.bearer, orderId)).status).toBe('pending_payment');
  });

  it('rejects a timestamp 301 s old with 400 STALE_WEBHOOK', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const { orderId, intentId } = await holdAndOrder(ctx, alice.bearer, eventId, [seatIds[0]!]);

    const res = await sendWebhook(ctx, succeeded(intentId), { t: Math.floor(Date.now() / 1000) - 301 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STALE_WEBHOOK');
    expect((await order(alice.bearer, orderId)).status).toBe('pending_payment');
  });

  it('keeps a declined order payable, then pays it on a later success', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const { holdId, orderId, intentId } = await holdAndOrder(ctx, alice.bearer, eventId, [seatIds[0]!]);

    await sendWebhook(ctx, { type: 'payment_intent.failed', intentId, failureCode: 'card_declined' });
    const declined = await order(alice.bearer, orderId);
    await sendWebhook(ctx, succeeded(intentId));
    const paid = await order(alice.bearer, orderId);

    expect(declined).toMatchObject({
      status: 'pending_payment',
      failureReason: 'PAYMENT_DECLINED',
      lastPaymentError: 'card_declined',
      tickets: [],
    });
    expect(paid).toMatchObject({ status: 'paid', failureReason: null, lastPaymentError: null });
    expect(paid.tickets).toHaveLength(1);
    expect(await holdStatus(ctx, holdId)).toBe('converted');
  });

  it('sells seats when the webhook arrives after held_until but seats were not taken', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const seats = seatIds.slice(0, 2);
    const { holdId, orderId, intentId } = await holdAndOrder(ctx, alice.bearer, eventId, seats);
    await expireHold(ctx, holdId, 30);

    const res = await sendWebhook(ctx, succeeded(intentId));

    expect(res.status).toBe(200);
    expect((await order(alice.bearer, orderId)).status).toBe('paid');
    expect((await seatRows(ctx, seats)).map((s) => s.status)).toEqual(['sold', 'sold']);
    expect(await ticketCount(seats)).toBe(2);
  });

  it('fails the order with HOLD_LOST and refunds when another buyer took the seats after expiry', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const [a, b] = seatIds as [number, number];
    const { holdId, orderId, intentId } = await holdAndOrder(ctx, alice.bearer, eventId, [a, b]);
    await expireHold(ctx, holdId, 30);
    const taken = await postHold(ctx, bob.bearer, eventId, [b]); // only one of the two seats
    expect(taken.status).toBe(201);
    const publish = vi.spyOn(ctx.deps.publisher, 'publish');

    const res = await sendWebhook(ctx, succeeded(intentId));

    expect(res.status).toBe(200);
    expect(await order(alice.bearer, orderId)).toMatchObject({ status: 'failed', failureReason: 'HOLD_LOST', tickets: [] });
    expect((await intent(intentId)).status).toBe('refunded');
    expect(await ticketCount([a, b])).toBe(0);
    // Nothing half-sold: the seat Alice still held is freed, Bob keeps his.
    expect(await seatRows(ctx, [a, b])).toEqual([
      { id: a, status: 'available', hold_id: null, order_id: null },
      { id: b, status: 'held', hold_id: taken.body.hold.id, order_id: null },
    ]);
    expect(await holdStatus(ctx, holdId)).toBe('expired');
    expect(publish).toHaveBeenCalledWith(eventId, [{ id: a, st: 'A' }]);
  });

  it('naive double-promise: the second payer fails with SEAT_ALREADY_SOLD and the seat has 1 ticket', async () => {
    const naive = getStrategy('naive');
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const [a] = seatIds as [number];
    const first = await naive.hold(ctx.deps, { eventId, userId: alice.user.id, seatIds: [a], ttlSec: 300 });
    // Replay naive's lost update: Bob's availability check ran before Alice's write landed.
    await ctx.deps.db.query(`UPDATE event_seats SET status = 'available', hold_id = NULL, held_until = NULL WHERE id = $1`, [a]);
    const second = await naive.hold(ctx.deps, { eventId, userId: bob.user.id, seatIds: [a], ttlSec: 300 });
    if (!first.ok || !second.ok) throw new Error('both naive holds should succeed');
    const alicesOrder = await postOrder(ctx, alice.bearer, first.hold.id);
    const bobsOrder = await postOrder(ctx, bob.bearer, second.hold.id);

    await sendWebhook(ctx, succeeded(alicesOrder.body.payment.intentId as string));
    const res = await sendWebhook(ctx, succeeded(bobsOrder.body.payment.intentId as string));

    expect(res.status).toBe(200);
    expect((await order(alice.bearer, alicesOrder.body.order.id as string)).status).toBe('paid');
    expect(await order(bob.bearer, bobsOrder.body.order.id as string)).toMatchObject({
      status: 'failed',
      failureReason: 'SEAT_ALREADY_SOLD',
    });
    expect((await intent(bobsOrder.body.payment.intentId as string)).status).toBe('refunded');
    expect(await ticketCount([a])).toBe(1);
    expect((await seatRows(ctx, [a]))[0]).toMatchObject({ status: 'sold', order_id: alicesOrder.body.order.id });
  });
});
