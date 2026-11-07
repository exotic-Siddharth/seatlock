import { randomUUID } from 'node:crypto';
import type { VenueLayout } from '@seatlock/shared';
import request from 'supertest';
import { signWebhook } from '../../src/payments/signature';
import type { TestCtx } from '../helpers';

/** Inserts `n` users in one statement (no sessions): for tests that call strategies directly. */
export async function insertUsers(ctx: TestCtx, n: number): Promise<string[]> {
  const { rows } = await ctx.deps.db.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash)
     SELECT 'race-' || $1::text || '-' || i || '@test.seatlock.dev', 'Racer ' || i, 'not-a-real-hash'
       FROM generate_series(1, $2::int) AS i
     RETURNING id`,
    [randomUUID().slice(0, 8), n],
  );
  return rows.map((r) => r.id);
}

/** One section of `rows` x 10 seats, all one tier. */
export function gridLayout(rows: number): VenueLayout {
  return {
    width: 200,
    height: 40 + rows * 10,
    stage: { x: 50, y: 5, w: 100, h: 20, label: 'Stage' },
    tiers: [{ key: 'gold', name: 'Gold' }],
    sections: [{ key: 'G', name: 'Grid', tier: 'gold', rows, seatsPerRow: 10, x: 50, y: 40, angle: 0 }],
  };
}

/** Moves a hold `secondsAgo` into the past, in both `holds` and `event_seats`, as if time had passed. */
export async function expireHold(ctx: TestCtx, holdId: string, secondsAgo = 1): Promise<void> {
  const past = `now() - make_interval(secs => ${Number(secondsAgo)})`;
  await ctx.deps.db.query(`UPDATE holds SET expires_at = ${past} WHERE id = $1`, [holdId]);
  await ctx.deps.db.query(`UPDATE event_seats SET held_until = ${past} WHERE hold_id = $1`, [holdId]);
}

export type Bearer = { Authorization: string };

export async function postHold(ctx: TestCtx, bearer: Bearer, eventId: string, seatIds: number[]) {
  return request(ctx.app).post('/api/holds').set(bearer).send({ eventId, seatIds });
}

export async function postOrder(ctx: TestCtx, bearer: Bearer, holdId: string, key = `order-${randomUUID()}`) {
  return request(ctx.app).post('/api/orders').set(bearer).set('Idempotency-Key', key).send({ holdId });
}

/** Holds the seats and creates an order for them; returns the ids a payment test needs. */
export async function holdAndOrder(ctx: TestCtx, bearer: Bearer, eventId: string, seatIds: number[]) {
  const hold = await postHold(ctx, bearer, eventId, seatIds);
  if (hold.status !== 201) throw new Error(`hold failed: ${JSON.stringify(hold.body)}`);
  const order = await postOrder(ctx, bearer, hold.body.hold.id as string);
  if (order.status !== 201) throw new Error(`order failed: ${JSON.stringify(order.body)}`);
  return {
    holdId: hold.body.hold.id as string,
    orderId: order.body.order.id as string,
    intentId: order.body.payment.intentId as string,
  };
}

export type PaymentEvent = {
  id?: string;
  type: 'payment_intent.succeeded' | 'payment_intent.failed';
  intentId: string;
  failureCode?: 'card_declined' | 'insufficient_funds';
};

/** Posts a MockPay webhook signed with the app's secret (or `opts.secret`), timestamped `opts.t`. */
export async function sendWebhook(
  ctx: TestCtx,
  event: PaymentEvent,
  opts: { t?: number; secret?: string; signature?: string } = {},
) {
  const body = JSON.stringify({
    id: event.id ?? `evt_${randomUUID().replace(/-/g, '')}`,
    type: event.type,
    data: { intentId: event.intentId, ...(event.failureCode ? { failureCode: event.failureCode } : {}) },
  });
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const signature = opts.signature ?? signWebhook(opts.secret ?? ctx.deps.config.mockpayWebhookSecret, body, t);
  return request(ctx.app)
    .post('/api/webhooks/mockpay')
    .set('Content-Type', 'application/json')
    .set('MockPay-Signature', signature)
    .send(body);
}

export async function seatRows(ctx: TestCtx, seatIds: number[]) {
  const { rows } = await ctx.deps.db.query<{ id: number; status: string; hold_id: string | null; order_id: string | null }>(
    'SELECT id, status::text AS status, hold_id, order_id FROM event_seats WHERE id = ANY($1) ORDER BY id',
    [seatIds],
  );
  return rows;
}

export async function holdStatus(ctx: TestCtx, holdId: string): Promise<string | undefined> {
  const { rows } = await ctx.deps.db.query<{ status: string }>('SELECT status::text AS status FROM holds WHERE id = $1', [
    holdId,
  ]);
  return rows[0]?.status;
}

/** Polls `check` every 25 ms until it returns true or `timeoutMs` passes. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
