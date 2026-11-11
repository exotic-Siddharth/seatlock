import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getActiveHoldForUser, releaseHoldsForEvent } from '../../src/booking/holds.service';
import { getStrategy } from '../../src/booking/strategies';
import { seatKey } from '../../src/booking/strategies/redis';
import { createOnSaleEvent, createUser, makeCtx, resetState, type TestCtx } from '../helpers';
import { expireHold, holdAndOrder, postHold, seatRows, sendWebhook, type Bearer } from './fixtures';

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

describe('getActiveHoldForUser', () => {
  it("returns the user's active hold on the event, and null once it lapses", async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const res = await postHold(ctx, alice.bearer, eventId, seatIds.slice(0, 2));

    const active = await getActiveHoldForUser(ctx.deps.db, alice.user.id, eventId);
    const someoneElse = await getActiveHoldForUser(ctx.deps.db, bob.user.id, eventId);
    await expireHold(ctx, res.body.hold.id as string);
    const lapsed = await getActiveHoldForUser(ctx.deps.db, alice.user.id, eventId);

    expect(active).toEqual({ id: res.body.hold.id, seatIds: seatIds.slice(0, 2), expiresAt: res.body.hold.expiresAt });
    expect(someoneElse).toBeNull();
    expect(lapsed).toBeNull();
  });
});

describe('releaseHoldsForEvent', () => {
  it("deletes the event's holds, orders, tickets and intents, frees every seat and clears its gate keys", async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const other = await createOnSaleEvent(ctx);
    const [a, b, c] = seatIds as [number, number, number];
    const paid = await holdAndOrder(ctx, alice.bearer, eventId, [a]);
    await sendWebhook(ctx, { type: 'payment_intent.succeeded', intentId: paid.intentId });
    await getStrategy('redis').hold(ctx.deps, { eventId, userId: bob.user.id, seatIds: [b, c], ttlSec: 300 });
    const untouched = await postHold(ctx, bob.bearer, other.eventId, [other.seatIds[0]!]);
    await ctx.deps.redis.set(seatKey(eventId, a), 'sold'); // as a redis-strategy sale leaves it

    await releaseHoldsForEvent(ctx.deps, eventId);

    expect(await seatRows(ctx, [a, b, c])).toEqual(
      [a, b, c].map((id) => ({ id, status: 'available', hold_id: null, order_id: null })),
    );
    const counts = await ctx.deps.db.query(
      `SELECT (SELECT count(*) FROM holds WHERE event_id = $1) AS holds,
              (SELECT count(*) FROM orders WHERE event_id = $1) AS orders,
              (SELECT count(*) FROM tickets WHERE event_id = $1) AS tickets,
              (SELECT count(*) FROM payment_intents WHERE id = $2) AS intents`,
      [eventId, paid.intentId],
    );
    expect(counts.rows[0]).toEqual({ holds: 0, orders: 0, tickets: 0, intents: 0 });
    expect(await ctx.deps.redis.exists(seatKey(eventId, a), seatKey(eventId, b), seatKey(eventId, c))).toBe(0);
    expect((await seatRows(ctx, [other.seatIds[0]!]))[0]).toMatchObject({ status: 'held', hold_id: untouched.body.hold.id });
  });
});
