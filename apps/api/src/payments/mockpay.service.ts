import { cardOutcome, type CardOutcome, type OrderStatus } from '@seatlock/shared';
import { z } from 'zod';
import { randomBase32 } from '../booking/codes';
import type { AppDeps } from '../context';
import { withTx, type Queryable } from '../db';
import { AppError } from '../errors';
import { signWebhook } from './signature';

/*
 * MockPay, a stand-in for an external card processor. It owns `payment_intents`, answers a
 * confirm at once with "processing", and reports the result later the way a real provider
 * does: an HMAC-signed webhook over HTTP to MOCKPAY_WEBHOOK_URL. The API trusts only that.
 */

/** The webhook body MockPay sends (and the webhook route accepts). */
export const PaymentEventSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['payment_intent.succeeded', 'payment_intent.failed']),
  data: z.object({
    intentId: z.string().min(1).max(100),
    failureCode: z.enum(['card_declined', 'insufficient_funds']).optional(),
  }),
});
export type PaymentEvent = z.infer<typeof PaymentEventSchema>;

/** A confirm may be retried once its webhook is this overdue (the process that owed it may have died). */
const STUCK_PROCESSING_SEC = 30;
const DELIVERY_ATTEMPTS = 3;

const randomId = (prefix: string) => `${prefix}_${randomBase32(24).toLowerCase()}`;

/** Creates the order's payment intent, inside the order's transaction. */
export async function createPaymentIntent(c: Queryable, orderId: string, amountPaise: number): Promise<string> {
  const id = randomId('pi');
  await c.query('INSERT INTO payment_intents (id, order_id, amount_paise) VALUES ($1, $2, $3)', [id, orderId, amountPaise]);
  return id;
}

type IntentState = {
  userId: string;
  orderStatus: OrderStatus;
  holdLapsed: boolean;
  inFlight: boolean;
};

/**
 * POST /api/mockpay/intents/:id/confirm. Starts a payment attempt and schedules its webhook.
 * The card number is used for the outcome and its last 4 digits; it is never stored or logged.
 */
export async function confirmPayment(
  deps: AppDeps,
  req: { intentId: string; userId: string; cardNumber: string },
): Promise<{ status: 'processing' }> {
  await withTx(deps.db, async (c) => {
    // The intent's row lock makes concurrent confirms (even with different keys) take turns.
    // The order is locked too (order before intent, like every other checkout path), so a
    // confirm that waited for a release of the same checkout reads the order as it now is.
    const { rows } = await c.query<IntentState>(
      `SELECT o.user_id AS "userId", o.status AS "orderStatus", h.expires_at <= now() AS "holdLapsed",
              (pi.status = 'processing' AND pi.updated_at > now() - make_interval(secs => $2)) AS "inFlight"
         FROM payment_intents pi
         JOIN orders o ON o.id = pi.order_id
         JOIN holds h ON h.id = o.hold_id
        WHERE pi.id = $1
          FOR UPDATE OF o, pi`,
      [req.intentId, STUCK_PROCESSING_SEC],
    );
    const intent = rows[0];
    if (!intent || intent.userId !== req.userId) throw new AppError('NOT_FOUND', 'Payment not found');
    if (intent.orderStatus !== 'pending_payment') {
      throw new AppError('HOLD_NOT_ACTIVE', 'This order is no longer waiting for payment');
    }
    if (intent.holdLapsed) throw new AppError('HOLD_EXPIRED', 'Your hold on these seats has expired');
    if (intent.inFlight) throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'A payment for this order is already processing');

    await c.query(
      `UPDATE payment_intents
          SET status = 'processing', attempts = attempts + 1, last4 = $2, failure_code = NULL, updated_at = now()
        WHERE id = $1`,
      [req.intentId, req.cardNumber.slice(-4)],
    );
  });

  scheduleWebhook(deps, req.intentId, cardOutcome(req.cardNumber));
  return { status: 'processing' };
}

function scheduleWebhook(deps: AppDeps, intentId: string, outcome: CardOutcome): void {
  const event: PaymentEvent =
    outcome === 'succeeded'
      ? { id: randomId('evt'), type: 'payment_intent.succeeded', data: { intentId } }
      : { id: randomId('evt'), type: 'payment_intent.failed', data: { intentId, failureCode: outcome } };
  const { min, max } = deps.config.mockpayLatencyMs;
  setTimeout(() => void deliver(deps, JSON.stringify(event)), min + Math.random() * (max - min)).unref();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** POSTs the webhook like a real provider: signed afresh on each attempt and retried with backoff. */
async function deliver(deps: AppDeps, body: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(deps.config.mockpayWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MockPay-Signature': signWebhook(deps.config.mockpayWebhookSecret, body, Math.floor(Date.now() / 1000)),
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      await res.body?.cancel();
      if (res.ok) return;
      throw new Error(`webhook answered ${res.status}`);
    } catch (err) {
      if (attempt >= DELIVERY_ATTEMPTS) {
        deps.log.error({ err }, 'MockPay gave up delivering a webhook');
        return;
      }
      await sleep(attempt * 1_000);
    }
  }
}
