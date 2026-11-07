import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardErrors, formatCardNumber, formatExpiry } from '../../src/features/checkout/card';
import Checkout from '../../src/pages/Checkout';
import { renderWithProviders } from '../render';
import { FAN, HOLD_ID, ORDER_ID, iso, makeHold, makeOrder } from './fixtures';
import { mockApi } from './mocks';

const INTENT = 'pi_TESTINTENT0000000000000000';
const ORDERS = 'POST /api/orders';
const CONFIRM = `POST /api/mockpay/intents/${INTENT}/confirm`;

function Where() {
  return <p data-testid="location">{useLocation().pathname}</p>;
}

function renderCheckout() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  renderWithProviders(
    <>
      <Routes>
        <Route path="/checkout/:holdId" element={<Checkout />} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </>,
    { route: `/checkout/${HOLD_ID}`, user: FAN },
  );
  return user;
}

const location = () => screen.getByTestId('location').textContent;
const created = { order: makeOrder(), payment: { intentId: INTENT, amountPaise: 499800 } };

/** Lets the 1 s order poll run. */
const nextPoll = () => act(() => vi.advanceTimersByTimeAsync(1_000));

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Checkout', () => {
  it('shows the hold summary, the countdown and the MockPay test cards', async () => {
    mockApi({ [`GET /api/holds/${HOLD_ID}`]: [200, { hold: makeHold() }] });
    renderCheckout();

    expect(await screen.findByText('Sec A · Row A · Seat 1')).toBeTruthy();
    expect(screen.getByRole('timer', { name: 'Time left to pay' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pay ₹4,998' })).toBeTruthy();
    expect(screen.getByText('Test mode')).toBeTruthy();
    for (const card of ['4242 4242 4242 4242', '4000 0000 0000 0002', '4000 0000 0000 9995']) {
      expect(screen.getByRole('button', { name: new RegExp(card) })).toBeTruthy();
    }
  });

  it('shows a decline, then lets the user retry with another card', async () => {
    let paid = false;
    const http = mockApi({
      [`GET /api/holds/${HOLD_ID}`]: [200, { hold: makeHold() }],
      [ORDERS]: [201, created],
      [CONFIRM]: [202, { status: 'processing' }],
      [`GET /api/orders/${ORDER_ID}`]: () => [
        200,
        { order: paid ? makeOrder({ status: 'paid' }) : makeOrder({ lastPaymentError: 'card_declined' }) },
      ],
    });
    const user = renderCheckout();

    await user.click(await screen.findByRole('button', { name: /4000 0000 0000 0002/ }));
    await user.click(screen.getByRole('button', { name: 'Pay ₹4,998' }));
    expect(await screen.findByText('Processing…')).toBeTruthy();
    await nextPoll();
    expect(await screen.findByText('Your card was declined.')).toBeTruthy();

    paid = true;
    await user.click(screen.getByRole('button', { name: /4242 4242 4242 4242/ }));
    await user.click(screen.getByRole('button', { name: 'Pay ₹4,998' }));
    await nextPoll();
    await waitFor(() => expect(location()).toBe(`/orders/${ORDER_ID}`));

    // One order for the hold; each Pay press is its own payment attempt.
    expect(http.callsTo(ORDERS)).toHaveLength(1);
    expect(http.callsTo(ORDERS)[0]!.body).toEqual({ holdId: HOLD_ID });
    const confirms = http.callsTo(CONFIRM);
    expect(confirms).toHaveLength(2);
    expect(confirms[0]!.headers['Idempotency-Key']).not.toBe(confirms[1]!.headers['Idempotency-Key']);
    expect(confirms[1]!.body).toMatchObject({ cardNumber: '4242424242424242', name: 'Asha Fan' });
  });

  it('retries a failed order request with the same Idempotency-Key', async () => {
    let attempts = 0;
    const http = mockApi({
      [`GET /api/holds/${HOLD_ID}`]: [200, { hold: makeHold() }],
      [ORDERS]: () => {
        if (++attempts === 1) throw new TypeError('Failed to fetch');
        return [201, created];
      },
      [CONFIRM]: [202, { status: 'processing' }],
      [`GET /api/orders/${ORDER_ID}`]: [200, { order: makeOrder({ status: 'paid' }) }],
    });
    const user = renderCheckout();

    await user.click(await screen.findByRole('button', { name: /4242 4242 4242 4242/ }));
    await user.click(screen.getByRole('button', { name: 'Pay ₹4,998' }));
    expect(await screen.findByText(/Could not reach Seatlock/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pay ₹4,998' }));
    await nextPoll();
    await waitFor(() => expect(location()).toBe(`/orders/${ORDER_ID}`));

    const [first, second] = http.callsTo(ORDERS);
    expect(first!.headers['Idempotency-Key']).toBeTruthy();
    expect(second!.headers['Idempotency-Key']).toBe(first!.headers['Idempotency-Key']);
  });

  it('reports a payment that failed for good', async () => {
    mockApi({
      [`GET /api/holds/${HOLD_ID}`]: [200, { hold: makeHold() }],
      [ORDERS]: [201, created],
      [CONFIRM]: [202, { status: 'processing' }],
      [`GET /api/orders/${ORDER_ID}`]: [200, { order: makeOrder({ status: 'failed', failureReason: 'HOLD_LOST' }) }],
    });
    const user = renderCheckout();
    await user.click(await screen.findByRole('button', { name: /4242 4242 4242 4242/ }));
    await user.click(screen.getByRole('button', { name: 'Pay ₹4,998' }));
    await nextPoll();
    expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeTruthy();
    expect(screen.getByText(/refunded/)).toBeTruthy();
  });

  it('blocks submit until the card details are valid', async () => {
    const http = mockApi({ [`GET /api/holds/${HOLD_ID}`]: [200, { hold: makeHold() }] });
    const user = renderCheckout();
    await user.type(await screen.findByLabelText('Card number'), '4242424242424241');
    await user.click(screen.getByRole('button', { name: 'Pay ₹4,998' }));
    expect(await screen.findByText('This card number is not valid')).toBeTruthy();
    expect(http.callsTo(ORDERS)).toHaveLength(0);
  });

  it('shows the expired state when the hold has run out', async () => {
    const now = Date.now();
    mockApi({ [`GET /api/holds/${HOLD_ID}`]: [200, { hold: makeHold({ serverTime: iso(now), expiresAt: iso(now) }) }] });
    renderCheckout();
    expect(await screen.findByRole('heading', { name: 'Your hold expired' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the seat map' }).getAttribute('href')).toBe('/events/monsoon-static');
  });

  it('releases the hold after confirmation', async () => {
    const http = mockApi({
      [`GET /api/holds/${HOLD_ID}`]: [200, { hold: makeHold() }],
      [`DELETE /api/holds/${HOLD_ID}`]: [204],
    });
    const user = renderCheckout();
    await user.click(await screen.findByRole('button', { name: 'Release seats' }));
    await user.click(screen.getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(location()).toBe('/events/monsoon-static'));
    expect(http.callsTo(`DELETE /api/holds/${HOLD_ID}`)).toHaveLength(1);
  });

  it('sends a converted hold to its order', async () => {
    mockApi({ [`GET /api/holds/${HOLD_ID}`]: [200, { hold: makeHold({ status: 'converted', orderId: ORDER_ID }) }] });
    renderCheckout();
    await waitFor(() => expect(location()).toBe(`/orders/${ORDER_ID}`));
  });

  it('shows a not-found state for an unknown hold', async () => {
    mockApi({});
    renderCheckout();
    expect(await screen.findByRole('heading', { name: 'Hold not found' })).toBeTruthy();
  });
});

describe('card helpers', () => {
  it('formats the card number in groups of four and the expiry as MM/YY', () => {
    expect(formatCardNumber('4242424242424242')).toBe('4242 4242 4242 4242');
    expect(formatCardNumber('4242 42x42')).toBe('4242 4242');
    expect(formatCardNumber('12345678901234567890')).toBe('1234 5678 9012 3456 789');
    expect(formatExpiry('1')).toBe('1');
    expect(formatExpiry('123')).toBe('12/3');
    expect(formatExpiry('12/34')).toBe('12/34');
  });

  it('validates with Luhn and the MockPay schema', () => {
    const now = new Date('2026-11-07T10:00:00Z');
    expect(cardErrors({ cardNumber: '4242 4242 4242 4242', expiry: '12/30', cvc: '123', name: 'A' }, now)).toEqual({});
    expect(cardErrors({ cardNumber: '4242 4242 4242 4241', expiry: '13/30', cvc: '1', name: '' }, now)).toEqual({
      cardNumber: 'This card number is not valid',
      expiry: 'Use MM/YY',
      cvc: 'CVC is 3 or 4 digits',
      name: 'Enter the name on the card',
    });
    expect(cardErrors({ cardNumber: '4242424242424242', expiry: '10/26', cvc: '123', name: 'A' }, now).expiry).toBe(
      'This card has expired',
    );
  });
});
