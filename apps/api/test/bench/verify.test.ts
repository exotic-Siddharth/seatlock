import { randomUUID } from 'node:crypto';
import type { StrategyName } from '@seatlock/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyEvent } from '../../src/bench/verify';
import { createOnSaleEvent, createUser, makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeCtx();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
});

const sql = <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  ctx.deps.db.query<T>(text, params);

type Fixture = { eventId: string; seatIds: number[]; userId: string };

async function setup(): Promise<Fixture> {
  const { eventId, seatIds } = await createOnSaleEvent(ctx);
  const { user } = await createUser(ctx);
  return { eventId, seatIds, userId: user.id };
}

async function insertHold(
  f: Fixture,
  seatIds: number[],
  opts: { status?: string; createdAt?: string; endedAt?: string | null; expiresAt?: string; amount?: number } = {},
): Promise<string> {
  const { rows } = await sql<{ id: string }>(
    `INSERT INTO holds (event_id, user_id, seat_ids, amount_paise, strategy, status, created_at, expires_at, ended_at)
     VALUES ($1, $2, $3, $4, 'conditional', $5, COALESCE($6::timestamptz, now()),
             COALESCE($7::timestamptz, now() + interval '2 minutes'), $8) RETURNING id`,
    [f.eventId, f.userId, seatIds, opts.amount ?? 0, opts.status ?? 'active', opts.createdAt ?? null, opts.expiresAt ?? null, opts.endedAt ?? null],
  );
  return rows[0]!.id;
}

async function insertOrder(
  f: Fixture,
  holdId: string,
  status: 'paid' | 'failed' | 'pending_payment',
  amount: number,
  failureReason?: string,
) {
  const { rows } = await sql<{ id: string }>(
    `INSERT INTO orders (user_id, event_id, hold_id, status, amount_paise, failure_reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [f.userId, f.eventId, holdId, status, amount, failureReason ?? null, randomUUID()],
  );
  return rows[0]!.id;
}

async function sell(seatIds: number[], orderId: string) {
  await sql(`UPDATE event_seats SET status='sold', order_id=$2 WHERE id = ANY($1)`, [seatIds, orderId]);
}

async function ticket(f: Fixture, orderId: string, seatId: number) {
  await sql(`INSERT INTO tickets (order_id, event_id, event_seat_id, user_id, code) VALUES ($1,$2,$3,$4,$5)`, [
    orderId,
    f.eventId,
    seatId,
    f.userId,
    `SL-${randomUUID()}`,
  ]);
}

async function seatsAmount(seatIds: number[]): Promise<number> {
  const { rows } = await sql<{ total: number }>(`SELECT sum(price_paise)::int AS total FROM event_seats WHERE id = ANY($1)`, [seatIds]);
  return rows[0]!.total;
}

/** A fully consistent sale: converted hold, paid order, sold seats, one ticket per seat. */
async function cleanSale(f: Fixture, seatIds: number[]) {
  const amount = await seatsAmount(seatIds);
  const holdId = await insertHold(f, seatIds, { status: 'converted', amount, endedAt: new Date().toISOString() });
  const orderId = await insertOrder(f, holdId, 'paid', amount);
  await sell(seatIds, orderId);
  for (const id of seatIds) await ticket(f, orderId, id);
  return { holdId, orderId, amount };
}

const verify = (f: Fixture, strategy: StrategyName = 'conditional') => verifyEvent(ctx.deps.db, f.eventId, { strategy });

const ZERO = {
  oversoldSeats: 0,
  soldSeatsWithoutTicket: 0,
  ticketsOnUnsoldSeats: 0,
  paidOrdersWithoutTickets: 0,
  ticketsWithoutPaidOrder: 0,
  paidAmountMismatch: 0,
  doublePromisedSeats: 0,
  refundedOrders: 0,
  pass: true,
};

describe('verifyEvent', () => {
  it('passes with all zeros for an untouched event', async () => {
    expect(await verify(await setup())).toEqual(ZERO);
  });

  it('passes with all zeros for a clean paid order', async () => {
    const f = await setup();
    await cleanSale(f, f.seatIds.slice(0, 2));
    expect(await verify(f)).toEqual(ZERO);
  });

  it('counts two overlapping holds on one seat as doublePromisedSeats and fails', async () => {
    const f = await setup();
    const seat = f.seatIds[0]!;
    await insertHold(f, [seat, f.seatIds[1]!]);
    await insertHold(f, [seat]);
    const result = await verify(f);
    expect(result.doublePromisedSeats).toBe(1);
    expect(result.pass).toBe(false);
  });

  it('does not count a seat taken over after the first hold expired, even when the sweeper marked it late', async () => {
    const f = await setup();
    const seat = f.seatIds[0]!;
    // A expired at 10:02:00 but the sweeper only stamped ended_at at 10:02:04. B legitimately took the seat at 10:02:01.
    await insertHold(f, [seat], {
      status: 'expired',
      createdAt: '2026-01-01T10:00:00Z',
      expiresAt: '2026-01-01T10:02:00Z',
      endedAt: '2026-01-01T10:02:04Z',
    });
    await insertHold(f, [seat], { createdAt: '2026-01-01T10:02:01Z', expiresAt: '2026-01-01T10:04:01Z' });
    expect((await verify(f)).doublePromisedSeats).toBe(0);
  });

  it('does not count a hold released at the instant the same user takes the seat again', async () => {
    const f = await setup();
    const seat = f.seatIds[0]!;
    await insertHold(f, [seat], { status: 'released', createdAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:01:00Z' });
    await insertHold(f, [seat], { createdAt: '2026-01-01T10:01:00Z' });
    expect((await verify(f)).doublePromisedSeats).toBe(0);
  });

  it('does count a hold that is still active when another hold on the seat starts', async () => {
    const f = await setup();
    const seat = f.seatIds[0]!;
    await insertHold(f, [seat], { createdAt: '2026-01-01T10:00:00Z', expiresAt: '2026-01-01T10:05:00Z' });
    await insertHold(f, [seat], { createdAt: '2026-01-01T10:04:59Z', expiresAt: '2026-01-01T10:09:59Z' });
    expect((await verify(f)).doublePromisedSeats).toBe(1);
  });

  it('counts a sold seat without a ticket and fails', async () => {
    const f = await setup();
    const [a, b, c] = f.seatIds as [number, number, number];
    const { orderId } = await cleanSale(f, [a, b]);
    await sell([c], orderId); // sold to a paid order but never ticketed
    expect(await verify(f)).toEqual({ ...ZERO, soldSeatsWithoutTicket: 1, pass: false });
  });

  it('counts a sold seat whose ticket belongs to a different order', async () => {
    const f = await setup();
    const [a, b] = f.seatIds as [number, number];
    const first = await cleanSale(f, [a]);
    const amount = await seatsAmount([b]);
    const holdId = await insertHold(f, [b], { status: 'converted', amount, endedAt: new Date().toISOString() });
    const second = await insertOrder(f, holdId, 'paid', amount);
    await sell([b], second);
    await ticket(f, first.orderId, b); // ticket for seat b filed under the wrong order
    const result = await verify(f);
    expect(result.soldSeatsWithoutTicket).toBe(1);
    expect(result.ticketsOnUnsoldSeats).toBe(1);
    expect(result.pass).toBe(false);
  });

  it('counts a ticket on a seat that is not sold', async () => {
    const f = await setup();
    const seat = f.seatIds[0]!;
    const amount = await seatsAmount([seat]);
    const holdId = await insertHold(f, [seat], { status: 'converted', amount });
    const orderId = await insertOrder(f, holdId, 'paid', amount);
    await ticket(f, orderId, seat); // the seat itself was never marked sold
    const result = await verify(f);
    expect(result.ticketsOnUnsoldSeats).toBe(1);
    expect(result.pass).toBe(false);
  });

  it('counts a paid order with no tickets, and one with only some of its tickets', async () => {
    const f = await setup();
    const [a, b, c] = f.seatIds as [number, number, number];
    const empty = await seatsAmount([a]);
    await insertOrder(f, await insertHold(f, [a], { status: 'converted', amount: empty }), 'paid', empty);

    const partial = await seatsAmount([b, c]);
    const orderId = await insertOrder(f, await insertHold(f, [b, c], { status: 'converted', amount: partial }), 'paid', partial);
    await sell([b], orderId);
    await ticket(f, orderId, b);

    const result = await verify(f);
    expect(result.paidOrdersWithoutTickets).toBe(2);
    expect(result.pass).toBe(false);
  });

  it('counts a ticket whose order is not paid', async () => {
    const f = await setup();
    const seat = f.seatIds[0]!;
    const holdId = await insertHold(f, [seat], { status: 'converted' });
    const orderId = await insertOrder(f, holdId, 'failed', 100, 'PAYMENT_DECLINED');
    await sell([seat], orderId);
    await ticket(f, orderId, seat);
    const result = await verify(f);
    expect(result.ticketsWithoutPaidOrder).toBe(1);
    expect(result.pass).toBe(false);
  });

  it('counts a paid order whose amount differs from the price of its tickets', async () => {
    const f = await setup();
    const seats = f.seatIds.slice(0, 2);
    const amount = await seatsAmount(seats);
    const holdId = await insertHold(f, seats, { status: 'converted', amount });
    const orderId = await insertOrder(f, holdId, 'paid', amount - 100);
    await sell(seats, orderId);
    for (const id of seats) await ticket(f, orderId, id);
    expect(await verify(f)).toEqual({ ...ZERO, paidAmountMismatch: 1, pass: false });
  });

  it('counts refunded orders but still passes', async () => {
    const f = await setup();
    const [a, b, c] = f.seatIds as [number, number, number];
    for (const [seat, reason] of [
      [a, 'HOLD_LOST'],
      [b, 'SEAT_ALREADY_SOLD'],
      [c, 'PAYMENT_DECLINED'], // a plain decline is not a refund
    ] as const) {
      const holdId = await insertHold(f, [seat], { status: 'expired', endedAt: new Date().toISOString() });
      await insertOrder(f, holdId, 'failed', 100, reason);
    }
    const result = await verify(f);
    expect(result.refundedOrders).toBe(2);
    expect(result.pass).toBe(true);
  });

  it('rejects a second ticket on one seat at the database level, so oversoldSeats stays 0', async () => {
    const f = await setup();
    const seat = f.seatIds[0]!;
    const { orderId } = await cleanSale(f, [seat]);
    await expect(ticket(f, orderId, seat)).rejects.toMatchObject({ code: '23505' });
    expect((await verify(f)).oversoldSeats).toBe(0);
  });

  it('excludes doublePromisedSeats from pass for naive, but still reports it and still fails on other violations', async () => {
    const f = await setup();
    const seat = f.seatIds[0]!;
    await insertHold(f, [seat]);
    await insertHold(f, [seat]);
    const naive = await verify(f, 'naive');
    expect(naive.doublePromisedSeats).toBe(1);
    expect(naive.pass).toBe(true);
    expect((await verify(f, 'redis')).pass).toBe(false);

    const { orderId } = await cleanSale(f, [f.seatIds[1]!]);
    await sell([f.seatIds[2]!], orderId); // sold seat without a ticket
    expect((await verify(f, 'naive')).pass).toBe(false);
  });

  it('only looks at the requested event', async () => {
    const f = await setup();
    const other = await createOnSaleEvent(ctx);
    const seat = other.seatIds[0]!;
    await insertHold({ ...f, eventId: other.eventId }, [seat]);
    await insertHold({ ...f, eventId: other.eventId }, [seat]);
    expect(await verify(f)).toEqual(ZERO);
  });
});
