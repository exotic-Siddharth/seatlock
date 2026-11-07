import { randomBytes, randomUUID } from 'node:crypto';
import type { TestCtx } from '../helpers';

/*
 * Direct-SQL state for tests, so these tests do not depend on the booking lane's code.
 */

/** Inserts a user that cannot log in and returns its id. */
export async function insertUser(ctx: TestCtx, name = 'Buyer'): Promise<string> {
  const { rows } = await ctx.deps.db.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [`${randomUUID().slice(0, 8)}@test.seatlock.dev`, name],
  );
  return rows[0]!.id;
}

/** An active hold on `seatIds`, expiring `minutes` from now (negative: already lapsed). */
export async function insertHold(
  ctx: TestCtx,
  opts: { eventId: string; userId: string; seatIds: number[]; minutes?: number },
): Promise<string> {
  const holdId = randomUUID();
  const minutes = opts.minutes ?? 5;
  await ctx.deps.db.query(
    `INSERT INTO holds (id, event_id, user_id, seat_ids, amount_paise, strategy, expires_at)
     VALUES ($1, $2, $3, $4, 1000, 'conditional', now() + make_interval(mins => $5))`,
    [holdId, opts.eventId, opts.userId, opts.seatIds, minutes],
  );
  await ctx.deps.db.query(
    `UPDATE event_seats SET status = 'held', hold_id = $1, held_until = now() + make_interval(mins => $3)
     WHERE id = ANY($2)`,
    [holdId, opts.seatIds, minutes],
  );
  return holdId;
}

/** A converted hold, a paid order, sold seats and one ticket per seat. */
export async function insertPaidOrder(
  ctx: TestCtx,
  opts: { eventId: string; userId: string; seatIds: number[]; amountPaise?: number },
): Promise<{ orderId: string; ticketCodes: string[] }> {
  const holdId = randomUUID();
  const amount = opts.amountPaise ?? 5000;
  await ctx.deps.db.query(
    `INSERT INTO holds (id, event_id, user_id, seat_ids, amount_paise, strategy, status, expires_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, 'conditional', 'converted', now(), now())`,
    [holdId, opts.eventId, opts.userId, opts.seatIds, amount],
  );
  const order = await ctx.deps.db.query<{ id: string }>(
    `INSERT INTO orders (user_id, event_id, hold_id, status, amount_paise, idempotency_key, paid_at)
     VALUES ($1, $2, $3, 'paid', $4, $5, now()) RETURNING id`,
    [opts.userId, opts.eventId, holdId, amount, randomUUID()],
  );
  const orderId = order.rows[0]!.id;
  await ctx.deps.db.query(
    `UPDATE event_seats SET status = 'sold', order_id = $2, hold_id = NULL, held_until = NULL WHERE id = ANY($1)`,
    [opts.seatIds, orderId],
  );
  const ticketCodes = opts.seatIds.map(() => `SL-${randomBytes(10).toString('hex').toUpperCase()}`);
  for (const [i, seatId] of opts.seatIds.entries()) {
    await ctx.deps.db.query(
      `INSERT INTO tickets (order_id, event_id, event_seat_id, user_id, code) VALUES ($1, $2, $3, $4, $5)`,
      [orderId, opts.eventId, seatId, opts.userId, ticketCodes[i]],
    );
  }
  return { orderId, ticketCodes };
}
