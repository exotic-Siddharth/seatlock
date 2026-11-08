import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyEvent } from '../../src/bench/verify';
import { releaseHold } from '../../src/booking/holds.service';
import { getStrategy } from '../../src/booking/strategies';
import { claimIfAvailable } from '../../src/booking/strategies/conditional';
import { seatKey } from '../../src/booking/strategies/redis';
import type { HoldRow } from '../../src/booking/strategies/types';
import { createOnSaleEvent, makeCtx, resetState, type TestCtx } from '../helpers';
import { holdStatus, insertUsers, orderState, seatRows } from './fixtures';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
});
afterAll(() => ctx.close());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(['naive', 'pessimistic', 'conditional', 'redis'] as const)('%s strategy', (name) => {
  const strategy = getStrategy(name);
  let eventId: string;
  let seats: number[];
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    ({ eventId, seatIds: seats } = await createOnSaleEvent(ctx));
    [alice, bob] = (await insertUsers(ctx, 2)) as [string, string];
  });

  const hold = (userId: string, seatIds: number[], ttlSec = 300) =>
    strategy.hold(ctx.deps, { eventId, userId, seatIds, ttlSec });

  it('holds free seats', async () => {
    const [a, b] = seats as [number, number];
    const result = await hold(alice, [a, b]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hold).toMatchObject({
      eventId,
      userId: alice,
      seatIds: [a, b],
      strategy: name,
      status: 'active',
      amountPaise: 2 * 249900,
    });
    expect(result.hold.expiresAt.getTime()).toBeGreaterThan(Date.now() + 290_000);
    expect(await seatRows(ctx, [a, b])).toEqual([
      { id: a, status: 'held', hold_id: result.hold.id, order_id: null },
      { id: b, status: 'held', hold_id: result.hold.id, order_id: null },
    ]);
  });

  it('reports a taken seat and holds none of the others', async () => {
    const [a, b] = seats as [number, number];
    await hold(alice, [a]);

    const result = await hold(bob, [b, a]);

    expect(result).toEqual({ ok: false, takenSeatIds: [a] });
    expect((await seatRows(ctx, [b]))[0]).toMatchObject({ status: 'available', hold_id: null });
    const { rowCount } = await ctx.deps.db.query('SELECT 1 FROM holds WHERE user_id = $1', [bob]);
    expect(rowCount).toBe(0);
  });

  it('takes over a hold whose held_until has passed', async () => {
    const [a] = seats as [number];
    await hold(alice, [a], 1);
    await sleep(1_200); // real expiry: Postgres held_until and, for redis, the gate key's PX

    const result = await hold(bob, [a]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await seatRows(ctx, [a]))[0]).toMatchObject({ status: 'held', hold_id: result.hold.id });
  });

  it("releases the user's previous hold on the event", async () => {
    const [a, b, c] = seats as [number, number, number];
    const first = await hold(alice, [a, b]);
    if (!first.ok) throw new Error('first hold failed');

    const second = await hold(alice, [c]);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(await holdStatus(ctx, first.hold.id)).toBe('released');
    expect(second.freed).toEqual([
      { id: a, eventId, holdId: first.hold.id },
      { id: b, eventId, holdId: first.hold.id },
    ]);
    expect(await seatRows(ctx, [a, b, c])).toEqual([
      { id: a, status: 'available', hold_id: null, order_id: null },
      { id: b, status: 'available', hold_id: null, order_id: null },
      { id: c, status: 'held', hold_id: second.hold.id, order_id: null },
    ]);
  });

  it('re-holding own seats plus one more succeeds', async () => {
    const [a, b, c] = seats as [number, number, number];
    const first = await hold(alice, [a, b]);
    if (!first.ok) throw new Error('first hold failed');

    const second = await hold(alice, [a, b, c]);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(await holdStatus(ctx, first.hold.id)).toBe('released');
    expect((await seatRows(ctx, [a, b, c])).map((s) => s.hold_id)).toEqual([second.hold.id, second.hold.id, second.hold.id]);
  });

  it('answers CHECKOUT_IN_PROGRESS before any seat conflict while a payment for the previous hold is processing', async () => {
    const [a, b] = seats as [number, number];
    const first = await hold(alice, [a]);
    if (!first.ok) throw new Error('first hold failed');
    const orderId = await placeOrder(first.hold, 'processing');
    await hold(bob, [b]);

    await expect(hold(alice, [b])).rejects.toMatchObject({ code: 'CHECKOUT_IN_PROGRESS' });
    expect(await holdStatus(ctx, first.hold.id)).toBe('active');
    expect(await orderState(ctx, orderId)).toMatchObject({ status: 'pending_payment', intent: 'processing' });
  });

  it('replaces a previous hold whose order has no payment in flight, failing that order with REPLACED', async () => {
    const [a, b] = seats as [number, number];
    const first = await hold(alice, [a]);
    if (!first.ok) throw new Error('first hold failed');
    const orderId = await placeOrder(first.hold, 'failed');

    const second = await hold(alice, [b]);

    expect(second.ok).toBe(true);
    expect(await holdStatus(ctx, first.hold.id)).toBe('released');
    expect(await orderState(ctx, orderId)).toEqual({ status: 'failed', failureReason: 'REPLACED', intent: 'failed' });
  });

  // naive has no transaction: it releases the previous hold before it looks at the seats.
  it.skipIf(name === 'naive')('leaves the previous hold and its order as they were when the new hold is refused', async () => {
    const [a, b] = seats as [number, number];
    const first = await hold(alice, [a]);
    if (!first.ok) throw new Error('first hold failed');
    const orderId = await placeOrder(first.hold, 'failed');
    await hold(bob, [b]);

    expect(await hold(alice, [b])).toEqual({ ok: false, takenSeatIds: [b] });
    expect(await holdStatus(ctx, first.hold.id)).toBe('active');
    expect(await orderState(ctx, orderId)).toMatchObject({ status: 'pending_payment', intent: 'failed' });
  });
});

/**
 * A pending order for the hold and its payment intent, as POST /api/orders leaves them, with
 * the intent in `intent`: 'processing' is a payment in flight, 'failed' a declined card.
 */
async function placeOrder(hold: HoldRow, intent: 'processing' | 'failed'): Promise<string> {
  const { rows } = await ctx.deps.db.query<{ id: string }>(
    `INSERT INTO orders (user_id, event_id, hold_id, amount_paise, idempotency_key) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [hold.userId, hold.eventId, hold.id, hold.amountPaise, `key-${hold.id}`],
  );
  const orderId = rows[0]!.id;
  await ctx.deps.db.query(
    `INSERT INTO payment_intents (id, order_id, amount_paise, status, attempts, failure_code)
     VALUES ($1, $2, $3, $4, 1, $5)`,
    [`pi_${orderId.replace(/-/g, '')}`, orderId, hold.amountPaise, intent, intent === 'failed' ? 'card_declined' : null],
  );
  return orderId;
}

describe('hold timestamps', () => {
  it('a claim that waited for a release starts after that release ended, so the bench verifier passes', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const seat = seatIds[0]!;
    const [alice, bob] = (await insertUsers(ctx, 2)) as [string, string];
    const first = await getStrategy('conditional').hold(ctx.deps, { eventId, userId: alice, seatIds: [seat], ttlSec: 300 });
    if (!first.ok) throw new Error('first hold failed');

    // Bob's transaction begins, Alice releases her hold and commits, then Bob claims the seat.
    const c = await ctx.deps.db.connect();
    try {
      await c.query('BEGIN');
      await sleep(20);
      await releaseHold(ctx.deps, first.hold.id, alice);
      const second = await claimIfAvailable(c, { eventId, userId: bob, seatIds: [seat], ttlSec: 300 }, 'conditional');
      await c.query('COMMIT');
      expect(second.ok).toBe(true);
    } finally {
      c.release();
    }

    expect(await verifyEvent(ctx.deps.db, eventId, { strategy: 'conditional' })).toMatchObject({
      doublePromisedSeats: 0,
      pass: true,
    });
  });
});

describe('redis strategy gate', () => {
  const redis = getStrategy('redis');
  let eventId: string;
  let seats: number[];
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    ({ eventId, seatIds: seats } = await createOnSaleEvent(ctx));
    [alice, bob] = (await insertUsers(ctx, 2)) as [string, string];
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets one gate key per seat to the hold id, with the hold TTL', async () => {
    const [a, b] = seats as [number, number];
    const result = await redis.hold(ctx.deps, { eventId, userId: alice, seatIds: [a, b], ttlSec: 300 });
    if (!result.ok) throw new Error('hold failed');

    for (const id of [a, b]) {
      expect(await ctx.deps.redis.get(seatKey(eventId, id))).toBe(result.hold.id);
      expect(await ctx.deps.redis.pttl(seatKey(eventId, id))).toBeGreaterThan(290_000);
    }
  });

  it('turns a loser away in Redis: one read, no transaction, nothing claimed', async () => {
    const [a, b] = seats as [number, number];
    await redis.hold(ctx.deps, { eventId, userId: alice, seatIds: [a], ttlSec: 300 });
    const query = vi.spyOn(ctx.deps.db, 'query');
    const connect = vi.spyOn(ctx.deps.db, 'connect');

    const result = await redis.hold(ctx.deps, { eventId, userId: bob, seatIds: [b, a], ttlSec: 300 });

    expect(result).toEqual({ ok: false, takenSeatIds: [a] });
    // The lookup of the buyer's own hold is the only statement; pool.query checks out the one
    // client it runs on, and a transaction would have checked out a second.
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]![0])).toMatch(/^\s*SELECT/);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await ctx.deps.redis.exists(seatKey(eventId, b))).toBe(0);
  });

  it("moves the gates of the buyer's re-held seats to the new hold", async () => {
    const [a, b, c] = seats as [number, number, number];
    await redis.hold(ctx.deps, { eventId, userId: alice, seatIds: [a, b], ttlSec: 300 });

    const second = await redis.hold(ctx.deps, { eventId, userId: alice, seatIds: [a, b, c], ttlSec: 300 });
    if (!second.ok) throw new Error('re-hold failed');

    for (const id of [a, b, c]) expect(await ctx.deps.redis.get(seatKey(eventId, id))).toBe(second.hold.id);
  });

  it("gives re-held seats' gates back to the previous hold when Postgres rejects the new one", async () => {
    const [a, b, c] = seats as [number, number, number];
    const first = await redis.hold(ctx.deps, { eventId, userId: alice, seatIds: [a, b], ttlSec: 300 });
    if (!first.ok) throw new Error('first hold failed');
    await ctx.deps.db.query(`UPDATE event_seats SET status = 'sold', order_id = gen_random_uuid() WHERE id = $1`, [c]);

    const result = await redis.hold(ctx.deps, { eventId, userId: alice, seatIds: [a, b, c], ttlSec: 300 });

    expect(result).toEqual({ ok: false, takenSeatIds: [c] });
    expect(await holdStatus(ctx, first.hold.id)).toBe('active');
    for (const id of [a, b]) {
      expect(await ctx.deps.redis.get(seatKey(eventId, id))).toBe(first.hold.id);
      expect(await ctx.deps.redis.pttl(seatKey(eventId, id))).toBeGreaterThan(290_000);
    }
    expect(await ctx.deps.redis.exists(seatKey(eventId, c))).toBe(0);
  });

  it('gives its gate keys back when the Postgres safety net rejects the seats', async () => {
    const [a, b] = seats as [number, number];
    // Sold through another strategy, so Redis has no key for it but Postgres does not allow it.
    await ctx.deps.db.query(
      `UPDATE event_seats SET status = 'sold', order_id = gen_random_uuid() WHERE id = $1`,
      [a],
    );

    const result = await redis.hold(ctx.deps, { eventId, userId: bob, seatIds: [a, b], ttlSec: 300 });

    expect(result).toEqual({ ok: false, takenSeatIds: [a] });
    expect(await ctx.deps.redis.exists(seatKey(eventId, a), seatKey(eventId, b))).toBe(0);
  });
});
