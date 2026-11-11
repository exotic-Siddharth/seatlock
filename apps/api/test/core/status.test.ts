import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AVAILABLE_SQL, EFFECTIVE_STATUS_SQL } from '../../src/events/status';
import { createOnSaleEvent, createUser, makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;
let eventId: string;
let seats: { free: number; live: number; lapsed: number; sold: number };

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
  const event = await createOnSaleEvent(ctx);
  eventId = event.eventId;
  const [free, live, lapsed, sold] = event.seatIds as [number, number, number, number];
  seats = { free, live, lapsed, sold };

  // A user, a hold and a paid order so the seat rows satisfy their CHECK constraints.
  const { user } = await createUser(ctx);
  const holdId = randomUUID();
  await ctx.deps.db.query(
    `INSERT INTO holds (id, event_id, user_id, seat_ids, amount_paise, strategy, expires_at)
     VALUES ($1, $2, $3, $4, 1, 'conditional', now() + interval '5 minutes')`,
    [holdId, eventId, user.id, [live, lapsed, sold]],
  );
  await ctx.deps.db.query(
    `UPDATE event_seats SET status = 'held', hold_id = $1,
       held_until = CASE WHEN id = $2 THEN now() + interval '5 minutes' ELSE now() - interval '1 second' END
     WHERE id = ANY($3)`,
    [holdId, live, [live, lapsed]],
  );
  const { rows } = await ctx.deps.db.query<{ id: string }>(
    `INSERT INTO orders (user_id, event_id, hold_id, status, amount_paise, idempotency_key)
     VALUES ($1, $2, $3, 'paid', 1, 'status-test') RETURNING id`,
    [user.id, eventId, holdId],
  );
  await ctx.deps.db.query(`UPDATE event_seats SET status = 'sold', order_id = $1 WHERE id = $2`, [rows[0]!.id, sold]);
});
afterAll(() => ctx.close());

describe('effective seat status', () => {
  it('treats a hold past held_until as available', async () => {
    const { rows } = await ctx.deps.db.query<{ id: number; st: string }>(
      `SELECT s.id, ${EFFECTIVE_STATUS_SQL('s')} AS st FROM event_seats s WHERE s.id = ANY($1) ORDER BY s.id`,
      [Object.values(seats)],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.st]))).toEqual({
      [seats.free]: 'available',
      [seats.live]: 'held',
      [seats.lapsed]: 'available',
      [seats.sold]: 'sold',
    });
  });

  it('AVAILABLE_SQL matches free seats and lapsed holds only', async () => {
    const { rows } = await ctx.deps.db.query<{ id: number }>(
      `SELECT seat.id FROM event_seats seat WHERE seat.id = ANY($1) AND ${AVAILABLE_SQL('seat')} ORDER BY seat.id`,
      [Object.values(seats)],
    );
    expect(rows.map((r) => r.id)).toEqual([seats.free, seats.lapsed]);
  });

  it('works without an alias, for unaliased UPDATE statements', async () => {
    const { rowCount } = await ctx.deps.db.query(
      `SELECT 1 FROM event_seats WHERE event_id = $1 AND ${AVAILABLE_SQL('')} AND ${EFFECTIVE_STATUS_SQL('')} = 'available'`,
      [eventId],
    );
    expect(rowCount).toBe(60 - 2);
  });

  it('refuses an alias that is not a plain identifier', () => {
    expect(() => AVAILABLE_SQL('s; DROP TABLE users')).toThrow();
  });
});
