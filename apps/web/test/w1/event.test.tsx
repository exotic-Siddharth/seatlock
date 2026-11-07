import type { User } from '@seatlock/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Event from '../../src/pages/Event';
import { renderWithProviders } from '../render';
import { EVENT_ID, FAN, HOLD_ID, iso, makeEvent, makeHold, makeQueue, makeSeats, makeSnapshot } from './fixtures';
import { MockEventSource, installEventSource, mockApi } from './mocks';

const SEATS_ROUTE = `GET /api/events/${EVENT_ID}/seats`;
const QUEUE_ROUTE = `/api/events/${EVENT_ID}/queue`;

function Where() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderEvent(user: User | null = FAN) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/events/:slug" element={<Event />} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </>,
    { route: '/events/monsoon-static', user },
  );
}

const seat = (name: string) => screen.findByRole('button', { name });
const holdButton = () => screen.getByRole('button', { name: /^Hold \d seats?$/ });

beforeEach(() => {
  installEventSource();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('Event page: picking seats', () => {
  it('shows the event, the live seat map and the tier legend', async () => {
    mockApi({ 'GET /api/events/monsoon-static': [200, { event: makeEvent() }], [SEATS_ROUTE]: [200, makeSnapshot()] });
    renderEvent();

    expect(await screen.findByRole('heading', { level: 1, name: 'Monsoon Static' })).toBeTruthy();
    expect(await seat('Sec A, Row A, Seat 1, Gold, ₹2,499, available')).toBeTruthy();
    const legend = screen.getByRole('list', { name: 'Price tiers' });
    expect(within(legend).getByText('Gold')).toBeTruthy();
    expect(within(legend).getByText('₹2,499')).toBeTruthy();
  });

  it('holds the selected seats and goes to checkout', async () => {
    const user = userEvent.setup();
    const http = mockApi({
      'GET /api/events/monsoon-static': [200, { event: makeEvent() }],
      [SEATS_ROUTE]: [200, makeSnapshot()],
      'POST /api/holds': [201, { hold: makeHold() }],
    });
    renderEvent();

    await user.click(await seat('Sec A, Row A, Seat 1, Gold, ₹2,499, available'));
    await user.click(await seat('Sec A, Row A, Seat 2, Gold, ₹2,499, available'));
    expect(screen.getByText('₹4,998')).toBeTruthy();
    await user.click(holdButton());

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/checkout/${HOLD_ID}`));
    expect(http.callsTo('POST /api/holds')[0]!.body).toEqual({ eventId: EVENT_ID, seatIds: [1, 2] });
  });

  it('flashes, deselects and reports the seats that were just taken', async () => {
    const user = userEvent.setup();
    let snapshots = 0;
    mockApi({
      'GET /api/events/monsoon-static': [200, { event: makeEvent() }],
      [SEATS_ROUTE]: () => [200, makeSnapshot({ seats: makeSeats(++snapshots > 1 ? { 2: 'H', 3: 'H' } : {}) })],
      'POST /api/holds': [
        409,
        { error: { code: 'SEATS_UNAVAILABLE', message: 'Some seats are taken', details: { takenSeatIds: [2, 3] } } },
      ],
    });
    renderEvent();

    for (const n of [1, 2, 3]) await user.click(await seat(`Sec A, Row A, Seat ${n}, Gold, ₹2,499, available`));
    await user.click(holdButton());

    expect(await screen.findByText('2 of your seats were just taken')).toBeTruthy();
    expect((await seat('Sec A, Row A, Seat 1, Gold, ₹2,499, selected')).getAttribute('aria-pressed')).toBe('true');
    const taken = await seat('Sec A, Row A, Seat 2, Gold, ₹2,499, held');
    expect(taken.getAttribute('class')).toContain('seat-flash');
    expect(holdButton().textContent).toBe('Hold 1 seat');
  });

  it('applies live updates and deselects a seat someone else takes', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/events/monsoon-static': [200, { event: makeEvent() }], [SEATS_ROUTE]: [200, makeSnapshot()] });
    renderEvent();
    await user.click(await seat('Sec A, Row A, Seat 4, Gold, ₹2,499, available'));

    act(() => MockEventSource.latest().emit('seats', { changes: [{ id: 4, st: 'H' }] }));

    expect(await screen.findByText('Seat A4 was just taken.')).toBeTruthy();
    expect(await seat('Sec A, Row A, Seat 4, Gold, ₹2,499, held')).toBeTruthy();
  });

  it('asks a guest to log in before holding', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/events/monsoon-static': [200, { event: makeEvent() }], [SEATS_ROUTE]: [200, makeSnapshot()] });
    renderEvent(null);
    await user.click(await seat('Sec A, Row A, Seat 1, Gold, ₹2,499, available'));
    const login = screen.getByRole('link', { name: 'Log in to hold seats' });
    expect(login.getAttribute('href')).toBe('/login?next=%2Fevents%2Fmonsoon-static');
  });

  it('offers to continue an active hold', async () => {
    mockApi({
      'GET /api/events/monsoon-static': [200, { event: makeEvent() }],
      [SEATS_ROUTE]: [
        200,
        makeSnapshot({ seats: makeSeats({ 5: 'H', 6: 'H' }), myHold: { id: HOLD_ID, seatIds: [5, 6], expiresAt: iso(Date.now() + 200_000) } }),
      ],
    });
    renderEvent();
    expect(await seat('Sec A, Row B, Seat 1, Gold, ₹2,499, held by you')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Continue to checkout' }).getAttribute('href')).toBe(`/checkout/${HOLD_ID}`);
  });

  it('shows a not-found state for an unknown event', async () => {
    mockApi({});
    renderEvent();
    expect(await screen.findByRole('heading', { name: 'Event not found' })).toBeTruthy();
  });

  it('shows the sold-out state', async () => {
    const seats = makeSeats(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, 'S' as const])));
    mockApi({
      'GET /api/events/monsoon-static': [200, { event: makeEvent({ status: 'sold_out', counts: { total: 16, available: 0 } }) }],
      [SEATS_ROUTE]: [200, makeSnapshot({ seats })],
    });
    renderEvent();
    expect(await screen.findByText('Sold out')).toBeTruthy();
    expect(await seat('Sec A, Row A, Seat 1, Gold, ₹2,499, sold')).toBeTruthy();
  });
});

describe('Event page: waiting room', () => {
  const queueEvent = () => makeEvent({ queueEnabled: true, admitRatePerSec: 5 });

  it('shows the place in line instead of the map', async () => {
    mockApi({
      'GET /api/events/monsoon-static': [200, { event: queueEvent() }],
      [`GET ${QUEUE_ROUTE}`]: [
        200,
        { queue: makeQueue({ state: 'waiting', position: 1234, aheadCount: 1233, queueLength: 3000, estimatedWaitSec: 247, saleOpensAt: iso(Date.now() - 1000) }) },
      ],
    });
    renderEvent();

    expect(await screen.findByRole('heading', { name: "You're in line" })).toBeTruthy();
    expect(screen.getByText('1,234')).toBeTruthy();
    expect(screen.getByText('1,233 people ahead of you')).toBeTruthy();
    expect(screen.getByText(/about 5 min/i)).toBeTruthy();
    expect(screen.getByText('Admitting 5 people per second')).toBeTruthy();
    expect(screen.getByText(/refreshing is safe/i)).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /, Row / })).toBeNull();
  });

  it('explains the lottery before the sale opens and joins on request', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/events/monsoon-static': [200, { event: queueEvent() }],
      [`GET ${QUEUE_ROUTE}`]: [200, { queue: makeQueue({ state: 'not_joined' }) }],
      [`POST ${QUEUE_ROUTE}`]: [200, { queue: makeQueue({ state: 'waiting', queueLength: 40 }) }],
    });
    renderEvent();

    await user.click(await screen.findByRole('button', { name: 'Join the line' }));
    expect(await screen.findByRole('heading', { name: "You're in line" })).toBeTruthy();
    expect(screen.getByText('Everyone who joins before the sale opens gets a random place when it opens.')).toBeTruthy();
    expect(screen.getByRole('timer', { name: 'Time until the sale opens' })).toBeTruthy();
  });

  it('opens the map once admitted and sends the queue token with the hold', async () => {
    const user = userEvent.setup();
    const http = mockApi({
      'GET /api/events/monsoon-static': [200, { event: queueEvent() }],
      [`GET ${QUEUE_ROUTE}`]: [
        200,
        { queue: makeQueue({ state: 'admitted', token: 'tok.sig', tokenExpiresAt: iso(Date.now() + 900_000), saleOpensAt: iso(Date.now() - 60_000) }) },
      ],
      [SEATS_ROUTE]: [200, makeSnapshot()],
      'POST /api/holds': [201, { hold: makeHold() }],
    });
    renderEvent();

    expect(await screen.findByRole('timer', { name: 'Time left in your access window' })).toBeTruthy();
    await user.click(await seat('Sec A, Row A, Seat 1, Gold, ₹2,499, available'));
    await user.click(holdButton());
    await waitFor(() => expect(http.callsTo('POST /api/holds')).toHaveLength(1));
    expect(http.callsTo('POST /api/holds')[0]!.headers['X-Queue-Token']).toBe('tok.sig');
    expect(sessionStorage.getItem(`seatlock:queue-token:${EVENT_ID}`)).toBe('tok.sig');
  });

  it('goes back to the waiting room when the hold says the queue token is invalid', async () => {
    const user = userEvent.setup();
    let admitted = true;
    mockApi({
      'GET /api/events/monsoon-static': [200, { event: queueEvent() }],
      [`GET ${QUEUE_ROUTE}`]: () => [
        200,
        {
          queue: admitted
            ? makeQueue({ state: 'admitted', token: 'tok.sig', tokenExpiresAt: iso(Date.now() + 900_000) })
            : makeQueue({ state: 'expired' }),
        },
      ],
      [SEATS_ROUTE]: [200, makeSnapshot()],
      'POST /api/holds': () => {
        admitted = false;
        return [403, { error: { code: 'QUEUE_TOKEN_INVALID', message: 'Queue token expired' } }];
      },
    });
    renderEvent();

    await user.click(await seat('Sec A, Row A, Seat 1, Gold, ₹2,499, available'));
    await user.click(holdButton());
    expect(await screen.findByRole('button', { name: 'Rejoin the line' })).toBeTruthy();
    expect(sessionStorage.getItem(`seatlock:queue-token:${EVENT_ID}`)).toBeNull();
  });

  it('asks a guest to log in to join', async () => {
    mockApi({ 'GET /api/events/monsoon-static': [200, { event: queueEvent() }] });
    renderEvent(null);
    expect(await screen.findByRole('link', { name: 'Log in to join the line' })).toBeTruthy();
  });
});
