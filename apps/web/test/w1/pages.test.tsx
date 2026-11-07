import type { EventSummary, Ticket } from '@seatlock/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Home from '../../src/pages/Home';
import NotFound from '../../src/pages/NotFound';
import OrderConfirmation from '../../src/pages/OrderConfirmation';
import Tickets from '../../src/pages/Tickets';
import { renderWithProviders } from '../render';
import { FAN, ORDER_ID, makeEvent, makeOrder } from './fixtures';
import { mockApi } from './mocks';

const ticket = (n: number, overrides: Partial<Ticket> = {}): Ticket => ({
  id: `c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6${n}`,
  code: `SL-ABCDEFGHJKMNPQRSTV${n}X`.slice(0, 23),
  seatLabel: `Sec A · Row A · Seat ${n}`,
  tier: 'gold',
  pricePaise: 249900,
  checkedInAt: null,
  ...overrides,
});
const paidOrder = makeOrder({ status: 'paid', paidAt: new Date().toISOString(), tickets: [ticket(1), ticket(2)] });

function summary(overrides: Partial<EventSummary>): EventSummary {
  const { description: _d, maxSeatsPerOrder: _m, holdTtlSeconds: _h, admitRatePerSec: _a, tierPrices: _t, layout: _l, serverTime: _s, ...rest } =
    makeEvent();
  return { ...rest, ...overrides };
}

// The QR encoder is a lazy chunk; load it once up front so assertions don't race module loading.
beforeAll(() => import('../../src/features/tickets/TicketQr'));
afterEach(() => vi.unstubAllGlobals());

describe('Home', () => {
  it('shows live stats and the upcoming events', async () => {
    mockApi({
      'GET /api/stats': [200, { ticketsSold: 12345, eventsOnSale: 5, activeHolds: 17 }],
      'GET /api/events': [
        200,
        {
          items: [
            summary({}),
            summary({ id: 'x', slug: 'quiet-hours', title: 'Quiet Hours', status: 'upcoming', queueEnabled: true }),
          ],
        },
      ],
    });
    renderWithProviders(<Home />);

    expect(await screen.findByText('12,345')).toBeTruthy();
    const grid = await screen.findByRole('list', { name: 'Events' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(2);
    expect(within(grid).getByRole('link', { name: /Monsoon Static/ }).getAttribute('href')).toBe('/events/monsoon-static');
    expect(within(grid).getByText('Waiting room')).toBeTruthy();
    expect(grid.textContent).toContain('From ₹999');
  });

  it('filters by category through the API', async () => {
    const http = mockApi({
      'GET /api/stats': [200, { ticketsSold: 0, eventsOnSale: 0, activeHolds: 0 }],
      'GET /api/events': [200, { items: [summary({})] }],
      'GET /api/events?category=comedy': [200, { items: [] }],
    });
    const user = userEvent.setup();
    renderWithProviders(<Home />);
    await user.click(await screen.findByRole('button', { name: 'Comedy' }));
    expect(await screen.findByText('No comedy events right now')).toBeTruthy();
    expect(http.callsTo('GET /api/events?category=comedy')).toHaveLength(1);
  });

  it('signs a guest in with Try the demo', async () => {
    const http = mockApi({
      'GET /api/stats': [200, { ticketsSold: 0, eventsOnSale: 0, activeHolds: 0 }],
      'GET /api/events': [200, { items: [] }],
      'POST /api/auth/demo': [200, { user: { ...FAN, name: 'Demo Fan' } }],
    });
    const user = userEvent.setup();
    renderWithProviders(<Home />);
    await user.click(screen.getByRole('button', { name: 'Try the demo' }));
    expect(await screen.findByText('Signed in as Demo Fan')).toBeTruthy();
    expect(http.callsTo('POST /api/auth/demo')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try the demo' })).toBeNull());
  });

  it('shows an error with a retry when events fail to load', async () => {
    mockApi({
      'GET /api/stats': [200, { ticketsSold: 0, eventsOnSale: 0, activeHolds: 0 }],
      'GET /api/events': [500, { error: { code: 'INTERNAL', message: 'boom' } }],
    });
    renderWithProviders(<Home />);
    expect(await screen.findByRole('heading', { name: 'Could not load events' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('OrderConfirmation', () => {
  const renderOrder = () =>
    renderWithProviders(
      <Routes>
        <Route path="/orders/:id" element={<OrderConfirmation />} />
      </Routes>,
      { route: `/orders/${ORDER_ID}`, user: FAN },
    );

  it('shows the tickets with QR codes for a paid order', async () => {
    mockApi({ [`GET /api/orders/${ORDER_ID}`]: [200, { order: paidOrder }] });
    renderOrder();
    expect(await screen.findByRole('heading', { name: /You're going/ })).toBeTruthy();
    expect(await screen.findAllByRole('img', { name: /^QR code for ticket SL-/ })).toHaveLength(2);
    expect(screen.getByText('Sec A · Row A · Seat 2')).toBeTruthy();
  });

  it('shows why a failed order failed', async () => {
    mockApi({ [`GET /api/orders/${ORDER_ID}`]: [200, { order: makeOrder({ status: 'failed', failureReason: 'HOLD_LOST' }) }] });
    renderOrder();
    expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeTruthy();
  });
});

describe('Tickets', () => {
  it('lists orders with their tickets and status', async () => {
    mockApi({
      'GET /api/orders': [
        200,
        { items: [{ ...paidOrder, tickets: [ticket(1, { checkedInAt: new Date().toISOString() }), ticket(2)] }, makeOrder({ id: 'p', status: 'failed', failureReason: 'HOLD_LOST' })] },
      ],
    });
    renderWithProviders(<Tickets />, { user: FAN });
    expect(await screen.findByRole('heading', { level: 1, name: 'My tickets' })).toBeTruthy();
    expect(await screen.findAllByRole('img', { name: /^QR code for ticket/ })).toHaveLength(2);
    expect(screen.getByText('Checked in')).toBeTruthy();
    expect(screen.getAllByText('Payment failed').length).toBeGreaterThan(0);
  });

  it('shows an empty state', async () => {
    mockApi({ 'GET /api/orders': [200, { items: [] }] });
    renderWithProviders(<Tickets />, { user: FAN });
    expect(await screen.findByRole('heading', { name: 'No tickets yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse events' })).toBeTruthy();
  });
});

describe('NotFound', () => {
  it('links back to the events', () => {
    renderWithProviders(<NotFound />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to events' }).getAttribute('href')).toBe('/');
  });
});
