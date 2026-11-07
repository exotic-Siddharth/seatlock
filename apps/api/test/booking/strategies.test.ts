import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStrategy } from '../../src/booking/strategies';
import { seatKey } from '../../src/booking/strategies/redis';
import { createOnSaleEvent, makeCtx, resetState, type TestCtx } from '../helpers';
import { holdStatus, insertUsers, seatRows } from './fixtures';

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

  it('rejects a loser in Redis without touching Postgres, and claims nothing for it', async () => {
    const [a, b] = seats as [number, number];
    await redis.hold(ctx.deps, { eventId, userId: alice, seatIds: [a], ttlSec: 300 });
    const query = vi.spyOn(ctx.deps.db, 'query');
    const connect = vi.spyOn(ctx.deps.db, 'connect');

    const result = await redis.hold(ctx.deps, { eventId, userId: bob, seatIds: [b, a], ttlSec: 300 });

    expect(result).toEqual({ ok: false, takenSeatIds: [a] });
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(await ctx.deps.redis.exists(seatKey(eventId, b))).toBe(0);
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
