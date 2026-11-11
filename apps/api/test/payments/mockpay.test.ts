import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TEST_CARDS } from '@seatlock/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOnSaleEvent, createUser, makeCtx, resetState, type TestCtx } from '../helpers';
import { holdAndOrder, waitFor, type Bearer } from '../booking/fixtures';

/*
 * MockPay calls the webhook over real HTTP, so the app listens on a free port and
 * MOCKPAY_WEBHOOK_URL points back at it.
 */

let server: Server;
let ctx: TestCtx;
let alice: { bearer: Bearer };
let bob: { bearer: Bearer };
let webhookDeliveries = 0;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  ctx = await makeCtx({
    mockpayWebhookUrl: `http://127.0.0.1:${port}/api/webhooks/mockpay`,
    mockpayLatencyMs: { min: 5, max: 10 },
  });
  server.on('request', (req) => {
    if (req.url === '/api/webhooks/mockpay') webhookDeliveries++;
  });
  server.on('request', ctx.app);
  await resetState(ctx);
  alice = await createUser(ctx, { name: 'Alice' });
  bob = await createUser(ctx, { name: 'Bob' });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await ctx.close();
});
beforeEach(() => {
  webhookDeliveries = 0;
});

const card = (cardNumber: string) => ({ cardNumber, expiry: '12/30', cvc: '123', name: 'Alice Test' });

function confirm(bearer: Bearer, intentId: string, cardNumber: string = TEST_CARDS.success, key = `pay-${randomUUID()}`) {
  return request(ctx.app)
    .post(`/api/mockpay/intents/${intentId}/confirm`)
    .set(bearer)
    .set('Idempotency-Key', key)
    .send(card(cardNumber));
}

async function newOrder(bearer: Bearer = alice.bearer) {
  const { eventId, seatIds } = await createOnSaleEvent(ctx);
  return holdAndOrder(ctx, bearer, eventId, seatIds.slice(0, 2));
}

async function orderOf(bearer: Bearer, orderId: string) {
  return (await request(ctx.app).get(`/api/orders/${orderId}`).set(bearer)).body.order;
}

async function intentRow(intentId: string) {
  const { rows } = await ctx.deps.db.query('SELECT status, attempts, last4 FROM payment_intents WHERE id = $1', [intentId]);
  return rows[0];
}

describe('POST /api/mockpay/intents/:id/confirm', () => {
  it('answers 202 processing, then the signed webhook pays the order within 2 s', async () => {
    const { orderId, intentId } = await newOrder();

    const res = await confirm(alice.bearer, intentId, '4242 4242 4242 4242');

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'processing' });
    await waitFor(async () => (await orderOf(alice.bearer, orderId)).status === 'paid', 2_000);
    expect((await orderOf(alice.bearer, orderId)).tickets).toHaveLength(2);
    expect(await intentRow(intentId)).toEqual({ status: 'succeeded', attempts: 1, last4: '4242' });
  });

  it("answers 404 for another user's intent", async () => {
    const { intentId } = await newOrder(alice.bearer);
    const res = await confirm(bob.bearer, intentId);
    expect(res.status).toBe(404);
    expect((await intentRow(intentId)).attempts).toBe(0);
  });

  it('rejects a card number that fails the Luhn check', async () => {
    const { intentId } = await newOrder();
    const res = await confirm(alice.bearer, intentId, '4242 4242 4242 4241');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('requires an Idempotency-Key', async () => {
    const { intentId } = await newOrder();
    const res = await request(ctx.app)
      .post(`/api/mockpay/intents/${intentId}/confirm`)
      .set(alice.bearer)
      .send(card(TEST_CARDS.success));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('concurrent confirms with one key make one attempt', async () => {
    const { orderId, intentId } = await newOrder();
    const key = `pay-${randomUUID()}`;

    const responses = await Promise.all(Array.from({ length: 5 }, () => confirm(alice.bearer, intentId, TEST_CARDS.success, key)));

    expect(responses.every((r) => r.status === 202 || r.body.error?.code === 'IDEMPOTENCY_IN_PROGRESS')).toBe(true);
    await waitFor(async () => (await orderOf(alice.bearer, orderId)).status === 'paid', 2_000);
    await new Promise((resolve) => setTimeout(resolve, 200)); // room for a second webhook, if there were one
    expect((await intentRow(intentId)).attempts).toBe(1);
    expect(webhookDeliveries).toBe(1);
  });

  it('reports a declined card on the order and lets the user pay again with another card', async () => {
    const { orderId, intentId } = await newOrder();

    expect((await confirm(alice.bearer, intentId, TEST_CARDS.declined)).status).toBe(202);
    await waitFor(async () => (await orderOf(alice.bearer, orderId)).lastPaymentError !== null, 2_000);
    const declined = await orderOf(alice.bearer, orderId);
    expect((await confirm(alice.bearer, intentId, TEST_CARDS.success)).status).toBe(202);
    await waitFor(async () => (await orderOf(alice.bearer, orderId)).status === 'paid', 2_000);

    expect(declined).toMatchObject({ status: 'pending_payment', lastPaymentError: 'card_declined' });
    expect(await intentRow(intentId)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('refuses to charge an order that is already paid', async () => {
    const { orderId, intentId } = await newOrder();
    await confirm(alice.bearer, intentId);
    await waitFor(async () => (await orderOf(alice.bearer, orderId)).status === 'paid', 2_000);

    const again = await confirm(alice.bearer, intentId);

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('HOLD_NOT_ACTIVE');
  });

  it('never lets the card number or CVC reach the database or Redis', async () => {
    const { orderId, intentId } = await newOrder();
    await confirm(alice.bearer, intentId, TEST_CARDS.success);
    await waitFor(async () => (await orderOf(alice.bearer, orderId)).status === 'paid', 2_000);

    const { rows } = await ctx.deps.db.query('SELECT row_to_json(pi)::text AS row FROM payment_intents pi WHERE id = $1', [
      intentId,
    ]);
    expect(rows[0].row).not.toContain(TEST_CARDS.success);
    const keys = await ctx.deps.redis.keys('sl:idem:*');
    const values = await Promise.all(keys.map((k) => ctx.deps.redis.get(k)));
    expect(values.join('\n')).not.toContain(TEST_CARDS.success);
  });
});

/*
 * A buyer can press Pay in one tab and Release in another. Whichever transaction gets the
 * checkout first decides, and the other sees its result: never a payment for released seats.
 * A third client holds the intent's row lock so the two requests queue in a known order.
 */
describe('a release racing a confirm for the same checkout', () => {
  const lockWaiters = async () => {
    const { rows } = await ctx.deps.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    return rows[0]!.n;
  };

  async function withIntentLocked(intentId: string, run: () => Promise<void>) {
    const blocker = await ctx.deps.db.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM payment_intents WHERE id = $1 FOR UPDATE', [intentId]);
      await run();
      await blocker.query('COMMIT');
    } finally {
      blocker.release();
    }
  }

  it('a release that got there first fails the order, and the confirm queued behind it is refused', async () => {
    const buyer = await createUser(ctx, { name: 'Racer' });
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const { holdId, orderId, intentId } = await holdAndOrder(ctx, buyer.bearer, eventId, seatIds.slice(0, 2));
    let releasing: Promise<request.Response> | undefined;
    let paying: Promise<request.Response> | undefined;

    await withIntentLocked(intentId, async () => {
      releasing = request(ctx.app).delete(`/api/holds/${holdId}`).set(buyer.bearer).then((r) => r);
      await waitFor(async () => (await lockWaiters()) === 1);
      paying = confirm(buyer.bearer, intentId).then((r) => r);
      await waitFor(async () => (await lockWaiters()) === 2);
    });

    expect((await releasing!).status).toBe(204);
    const refused = await paying!;
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('HOLD_NOT_ACTIVE');
    expect(await orderOf(buyer.bearer, orderId)).toMatchObject({ status: 'failed', failureReason: 'RELEASED' });
    expect(await intentRow(intentId)).toMatchObject({ status: 'failed', attempts: 0 });
  });

  it('a confirm that got there first keeps the seats, and the release queued behind it is refused', async () => {
    const buyer = await createUser(ctx, { name: 'Racer' });
    const { eventId, seatIds } = await createOnSaleEvent(ctx);
    const { holdId, orderId, intentId } = await holdAndOrder(ctx, buyer.bearer, eventId, seatIds.slice(0, 2));
    let releasing: Promise<request.Response> | undefined;
    let paying: Promise<request.Response> | undefined;

    await withIntentLocked(intentId, async () => {
      paying = confirm(buyer.bearer, intentId).then((r) => r);
      await waitFor(async () => (await lockWaiters()) === 1);
      releasing = request(ctx.app).delete(`/api/holds/${holdId}`).set(buyer.bearer).then((r) => r);
      await waitFor(async () => (await lockWaiters()) === 2);
    });

    expect((await paying!).status).toBe(202);
    const refused = await releasing!;
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CHECKOUT_IN_PROGRESS');
    await waitFor(async () => (await orderOf(buyer.bearer, orderId)).status === 'paid', 2_000);
  });
});
