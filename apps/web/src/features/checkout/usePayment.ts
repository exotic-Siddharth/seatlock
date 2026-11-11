import type { CreateOrderResponse, Hold, Order } from '@seatlock/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, api, errorMessage, newIdempotencyKey } from '../../lib/api';
import { declineMessage, type CardForm } from './card';
import { holdKey, orderKey } from './queries';

export type PaymentState =
  /** The form can be used; `error` is what went wrong last time, if anything. */
  | { step: 'ready'; error?: string }
  /** Creating the order and sending the card to MockPay. */
  | { step: 'paying' }
  /** MockPay accepted the card; waiting for its webhook to settle the order. */
  | { step: 'processing' }
  /** No outcome within the polling window. The payment may still go through. */
  | { step: 'slow' }
  /** The order failed for good (for example, the hold was lost and the payment refunded); `reason` is its failureReason. */
  | { step: 'failed'; reason: string | null };

const POLL_EVERY_MS = 1_000;
const POLL_FOR_MS = 15_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/**
 * Polls the order until the webhook has settled this attempt: paid, failed, or still pending
 * with a payment error (declined, so the user can retry). Null if 15 s pass with no outcome.
 */
async function waitForOutcome(orderId: string, signal: AbortSignal): Promise<Order | null> {
  for (let waited = 0; waited < POLL_FOR_MS; waited += POLL_EVERY_MS) {
    await sleep(POLL_EVERY_MS, signal);
    try {
      const { order } = await api<{ order: Order }>(`/api/orders/${orderId}`, { signal });
      if (order.status !== 'pending_payment' || order.lastPaymentError) return order;
    } catch (error) {
      // A failed poll changes nothing about the payment; the next one tries again.
      if (signal.aborted) throw error;
    }
  }
  return null;
}

/** Pays for a hold: creates its order once, confirms the card with MockPay, then waits for the outcome. */
export function usePayment(hold: Hold) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<PaymentState>({ step: 'ready' });
  // One key for this hold's order, kept across retries: if a response is lost, sending the
  // request again returns the same order instead of making another.
  const [orderIdempotencyKey] = useState(newIdempotencyKey);
  const payment = useRef<{ orderId: string; intentId: string } | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  const settle = useCallback(
    async (orderId: string, signal: AbortSignal) => {
      setState({ step: 'processing' });
      const order = await waitForOutcome(orderId, signal);
      if (!order) return setState({ step: 'slow' });
      queryClient.setQueryData(orderKey(order.id), { order });
      if (order.status === 'paid') return navigate(`/orders/${order.id}`, { replace: true });
      if (order.status === 'failed') return setState({ step: 'failed', reason: order.failureReason });
      setState({ step: 'ready', error: declineMessage(order.lastPaymentError!) });
    },
    [navigate, queryClient],
  );

  const run = useCallback(
    async (work: (signal: AbortSignal) => Promise<void>) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      try {
        await work(controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && (error.code === 'HOLD_EXPIRED' || error.code === 'HOLD_NOT_ACTIVE')) {
          void queryClient.invalidateQueries({ queryKey: holdKey(hold.id) });
        }
        setState({ step: 'ready', error: errorMessage(error) });
      }
    },
    [hold.id, queryClient],
  );

  const pay = (card: CardForm) =>
    run(async (signal) => {
      setState({ step: 'paying' });
      if (!payment.current) {
        const created = await api<CreateOrderResponse>('/api/orders', {
          body: { holdId: hold.id },
          headers: { 'Idempotency-Key': orderIdempotencyKey },
          signal,
        });
        payment.current = { orderId: created.order.id, intentId: created.payment.intentId };
        // Creating the order extends the hold; fetch it again for the new deadline.
        void queryClient.invalidateQueries({ queryKey: holdKey(hold.id) });
      }
      const { orderId, intentId } = payment.current;
      // Each press of Pay is a new payment attempt, so it gets its own key.
      await api(`/api/mockpay/intents/${intentId}/confirm`, {
        body: { ...card, cardNumber: card.cardNumber.replace(/\s/g, '') },
        headers: { 'Idempotency-Key': newIdempotencyKey() },
        signal,
      });
      await settle(orderId, signal);
    });

  /** After a slow answer: look at the order again. */
  const checkAgain = () =>
    run(async (signal) => {
      if (payment.current) await settle(payment.current.orderId, signal);
    });

  return { state, pay, checkAgain };
}
