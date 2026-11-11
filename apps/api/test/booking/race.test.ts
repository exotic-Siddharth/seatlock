import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyEvent } from '../../src/bench/verify';
import { getStrategy } from '../../src/booking/strategies';
import { createNaive } from '../../src/booking/strategies/naive';
import { createOnSaleEvent, createVenue, makeCtx, resetState, type TestCtx } from '../helpers';
import { gridLayout, insertUsers } from './fixtures';

/*
 * Real Postgres and Redis, no mocks: hundreds of concurrent hold() calls through the
 * app's own pool (PG_POOL_MAX connections), as in spec §11 "Race tests in CI".
 */

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
});
afterAll(() => ctx.close());

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe.each(['pessimistic', 'conditional', 'redis'] as const)('%s under contention', (name) => {
  const strategy = getStrategy(name);

  it('lets exactly 1 of 200 users hold the same 3 seats', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const hot = seatIds.slice(0, 3);
    const users = await insertUsers(ctx, 200);

    const results = await Promise.all(
      users.map((userId) => strategy.hold(ctx.deps, { eventId, userId, seatIds: hot, ttlSec: 300 })),
    );

    const winners = results.flatMap((r) => (r.ok ? [r.hold] : []));
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.takenSeatIds.length > 0)).toHaveLength(199);

    const { rows } = await ctx.deps.db.query<{ id: string }>(
      `SELECT id FROM holds WHERE event_id = $1 AND status = 'active'`,
      [eventId],
    );
    expect(rows).toEqual([{ id: winners[0]!.id }]);
    const held = await ctx.deps.db.query(`SELECT 1 FROM event_seats WHERE id = ANY($1) AND hold_id = $2`, [
      hot,
      winners[0]!.id,
    ]);
    expect(held.rowCount).toBe(3);
  });

  it('gives each of 100 seats to exactly one of 300 users', async () => {
    const { venueId } = await createVenue(ctx, gridLayout(10));
    const { eventId, seatIds } = await createOnSaleEvent(ctx, { venueId, tierPrices: { gold: 50000 } });
    expect(seatIds).toHaveLength(100);
    const users = await insertUsers(ctx, 300);
    // Every seat is wanted by exactly 3 users, so a correct strategy has exactly 100 winners.
    const attempts = shuffle(users.map((userId, i) => ({ userId, seatId: seatIds[i % 100]! })));

    const results = await Promise.all(
      attempts.map(({ userId, seatId }) => strategy.hold(ctx.deps, { eventId, userId, seatIds: [seatId], ttlSec: 300 })),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(100);
    const doubleHeld = await ctx.deps.db.query(
      `SELECT seat FROM holds, unnest(seat_ids) AS seat
        WHERE event_id = $1 AND status = 'active'
        GROUP BY seat HAVING count(*) > 1`,
      [eventId],
    );
    expect(doubleHeld.rows).toEqual([]);
    const consistent = await ctx.deps.db.query(
      `SELECT 1 FROM event_seats s JOIN holds h ON h.id = s.hold_id
        WHERE s.event_id = $1 AND s.status = 'held' AND h.status = 'active' AND s.id = ANY(h.seat_ids)`,
      [eventId],
    );
    expect(consistent.rowCount).toBe(100);
  });

  it('leaves a buyer who fires 10 holds at once with one active hold', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const [userId] = (await insertUsers(ctx, 1)) as [string];

    const results = await Promise.all(
      seatIds.slice(0, 10).map((seatId) => strategy.hold(ctx.deps, { eventId, userId, seatIds: [seatId], ttlSec: 300 })),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const active = await ctx.deps.db.query(
      `SELECT seat_ids FROM holds WHERE event_id = $1 AND user_id = $2 AND status = 'active'`,
      [eventId, userId],
    );
    expect(active.rowCount).toBe(1);
    const held = await ctx.deps.db.query(`SELECT 1 FROM event_seats WHERE event_id = $1 AND status = 'held'`, [eventId]);
    expect(held.rowCount).toBe(1);
  });
});

/** Resolves for everyone once `n` callers have arrived. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return () => {
    if (++arrived === n) open();
    return opened;
  };
}

/*
 * The Lab and the README rest on naive being unsafe, so CI proves it. Each racer is held
 * between naive's availability check and its write until all 200 have checked: the window
 * naive leaves open, held open on purpose, so the outcome does not depend on how the pool
 * happens to schedule the queries. A naive that became safe (a lock, a transaction or a
 * condition on the write) would either let only one through or never get past the barrier.
 */
describe('naive under contention', () => {
  it('lets more than one of 200 users "win" the same 3 seats, and the bench verifier sees the double promise', async () => {
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const hot = seatIds.slice(0, 3);
    const users = await insertUsers(ctx, 200);
    const naive = createNaive({ betweenCheckAndWrite: barrier(users.length) });

    const results = await Promise.all(
      users.map((userId) => naive.hold(ctx.deps, { eventId, userId, seatIds: hot, ttlSec: 300 })),
    );

    expect(results.filter((r) => r.ok).length).toBeGreaterThan(1);
    const { rows } = await ctx.deps.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM holds WHERE event_id = $1 AND status = 'active' AND seat_ids && $2::bigint[]`,
      [eventId, hot],
    );
    expect(rows[0]!.n).toBeGreaterThan(1);
    expect(await verifyEvent(ctx.deps.db, eventId, { strategy: 'naive' })).toMatchObject({
      doublePromisedSeats: 3,
      oversoldSeats: 0,
      pass: true,
    });
  });
});
