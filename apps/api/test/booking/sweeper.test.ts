import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getStrategy } from '../../src/booking/strategies';
import { seatKey } from '../../src/booking/strategies/redis';
import { startSweeper, sweepOnce } from '../../src/booking/sweeper';
import { createOnSaleEvent, createUser, makeCtx, resetState, type TestCtx } from '../helpers';
import { expireHold, holdStatus, postHold, postOrder, seatRows, sendWebhook, waitFor, type Bearer } from './fixtures';

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

/**
 * Orders the hold, then lets it lapse with the timestamps the app produces: an order extends
 * its hold to at least created_at + 120 s, so by the time the hold lapses the order is 120 s old.
 */
async function lapsedWithOrder(holdId: string) {
  const order = await postOrder(ctx, alice.bearer, holdId);
  await expireHold(ctx, holdId, 10);
  await ctx.deps.db.query(
    `UPDATE orders o SET created_at = h.expires_at - interval '120 seconds' FROM holds h WHERE h.id = o.hold_id AND o.id = $1`,
    [order.body.order.id],
  );
  return { orderId: order.body.order.id as string, intentId: order.body.payment.intentId as string };
}

/** What MockPay's confirm records: an attempt in flight since `secondsAgo`. */
async function startPayment(orderId: string, secondsAgo: number) {
  await ctx.deps.db.query(
    `UPDATE payment_intents SET status = 'processing', attempts = attempts + 1, updated_at = now() - make_interval(secs => $2)
      WHERE order_id = $1`,
    [orderId, secondsAgo],
  );
}

async function heldHold(seatCount = 2, bearer: Bearer = alice.bearer) {
  const { eventId, seatIds } = await createOnSaleEvent(ctx);
  const seats = seatIds.slice(0, seatCount);
  const res = await postHold(ctx, bearer, eventId, seats);
  return { eventId, seats, holdId: res.body.hold.id as string };
}

describe('sweepOnce', () => {
  it('frees the seats of lapsed holds and marks the holds expired at their expiry time', async () => {
    const { seats, holdId } = await heldHold(2);
    await expireHold(ctx, holdId, 10);

    const freed = await sweepOnce(ctx.deps);

    expect(freed).toBeGreaterThanOrEqual(2);
    expect((await seatRows(ctx, seats)).map((s) => s.status)).toEqual(['available', 'available']);
    const { rows } = await ctx.deps.db.query('SELECT status::text, ended_at = expires_at AS ended_at_expiry FROM holds WHERE id = $1', [
      holdId,
    ]);
    expect(rows[0]).toEqual({ status: 'expired', ended_at_expiry: true });
  });

  it('leaves unexpired holds alone', async () => {
    const { seats, holdId } = await heldHold(1);
    await sweepOnce(ctx.deps);
    expect(await holdStatus(ctx, holdId)).toBe('active');
    expect((await seatRows(ctx, seats))[0]!.status).toBe('held');
  });

  it('skips a lapsed hold while its payment is processing, for up to 60 s', async () => {
    const { seats, holdId } = await heldHold(1);
    const { orderId } = await lapsedWithOrder(holdId);
    await startPayment(orderId, 0);

    await sweepOnce(ctx.deps);
    const whilePaying = { hold: await holdStatus(ctx, holdId), seat: (await seatRows(ctx, seats))[0]!.status };
    await startPayment(orderId, 61); // the webhook is long overdue
    await sweepOnce(ctx.deps);

    expect(whilePaying).toEqual({ hold: 'active', seat: 'held' });
    expect(await holdStatus(ctx, holdId)).toBe('expired');
    expect((await seatRows(ctx, seats))[0]!.status).toBe('available');
  });

  it('expires a lapsed hold whose order has no payment in flight', async () => {
    const { seats, holdId } = await heldHold(1);
    await lapsedWithOrder(holdId);

    await sweepOnce(ctx.deps);

    expect(await holdStatus(ctx, holdId)).toBe('expired');
    expect((await seatRows(ctx, seats))[0]!.status).toBe('available');
  });

  it('lets a payment still processing at expiry sell the seats when its webhook lands after a sweep', async () => {
    const { seats, holdId } = await heldHold(2);
    const { orderId, intentId } = await lapsedWithOrder(holdId);
    await startPayment(orderId, 0);

    await sweepOnce(ctx.deps);
    await sendWebhook(ctx, { type: 'payment_intent.succeeded', intentId });

    const { rows } = await ctx.deps.db.query('SELECT status::text FROM orders WHERE id = $1', [orderId]);
    expect(rows[0]).toEqual({ status: 'paid' });
    expect((await seatRows(ctx, seats)).map((s) => s.status)).toEqual(['sold', 'sold']);
  });

  it('expires a lapsed hold whose seats another buyer already took over', async () => {
    const { eventId, seats, holdId } = await heldHold(1);
    await expireHold(ctx, holdId, 10);
    const takeover = await postHold(ctx, bob.bearer, eventId, seats);

    await sweepOnce(ctx.deps);

    expect(await holdStatus(ctx, holdId)).toBe('expired');
    expect((await seatRows(ctx, seats))[0]).toMatchObject({ status: 'held', hold_id: takeover.body.hold.id });
  });

  it('publishes the freed seats per event', async () => {
    const one = await heldHold(2);
    const two = await heldHold(1, bob.bearer);
    await expireHold(ctx, one.holdId);
    await expireHold(ctx, two.holdId);
    const publish = vi.spyOn(ctx.deps.publisher, 'publish');

    await sweepOnce(ctx.deps);

    expect(publish).toHaveBeenCalledWith(one.eventId, one.seats.map((id) => ({ id, st: 'A' })));
    expect(publish).toHaveBeenCalledWith(two.eventId, two.seats.map((id) => ({ id, st: 'A' })));
  });

  it('compare-and-deletes the Redis gate keys of the freed seats', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const [a, b] = seatIds as [number, number];
    const result = await getStrategy('redis').hold(ctx.deps, { eventId, userId: alice.user.id, seatIds: [a, b], ttlSec: 300 });
    if (!result.ok) throw new Error('hold failed');
    await expireHold(ctx, result.hold.id);
    // Meanwhile another hold claimed seat b's gate: that key is not ours to delete.
    await ctx.deps.redis.set(seatKey(eventId, b), 'another-hold');

    await sweepOnce(ctx.deps);

    expect(await ctx.deps.redis.exists(seatKey(eventId, a))).toBe(0);
    expect(await ctx.deps.redis.get(seatKey(eventId, b))).toBe('another-hold');
  });
});

describe('startSweeper', () => {
  it('sweeps on its own until stopped', async () => {
    const { seats, holdId } = await heldHold(1);
    await expireHold(ctx, holdId);

    const stop = startSweeper(ctx.deps);
    try {
      await waitFor(async () => (await holdStatus(ctx, holdId)) === 'expired', 3_000);
    } finally {
      stop();
    }
    expect((await seatRows(ctx, seats))[0]!.status).toBe('available');
  });
});
