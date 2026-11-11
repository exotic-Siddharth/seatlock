import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Checkout from '../../src/pages/Checkout';
import Event from '../../src/pages/Event';
import { renderWithProviders } from '../render';
import { EVENT_ID, FAN, HOLD_ID, iso, makeEvent, makeHold, makeSnapshot } from './fixtures';
import { installEventSource, mockApi } from './mocks';

const FIVE_MIN = 5 * 60_000;
let serverNow = 0;

beforeEach(() => {
  installEventSource();
  const realNow = Date.now.bind(Date);
  serverNow = realNow();
  // The device clock runs 5 minutes fast.
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + FIVE_MIN);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('countdowns use server time', () => {
  it('remaining time is correct when the client clock is 5 minutes fast', async () => {
    mockApi({
      [`GET /api/holds/${HOLD_ID}`]: [200, { hold: makeHold({ serverTime: iso(serverNow), expiresAt: iso(serverNow + FIVE_MIN) }) }],
    });
    renderWithProviders(
      <Routes>
        <Route path="/checkout/:holdId" element={<Checkout />} />
      </Routes>,
      { route: `/checkout/${HOLD_ID}`, user: FAN },
    );

    const timer = await screen.findByRole('timer', { name: 'Time left to pay' });
    expect(timer.textContent).toMatch(/^0(5:00|4:5\d)$/);
    expect(screen.queryByRole('heading', { name: 'Your hold expired' })).toBeNull();
  });

  it('counts down to the sale opening in server time', async () => {
    const event = makeEvent({ status: 'upcoming', serverTime: iso(serverNow), saleOpensAt: iso(serverNow + 3 * 60_000) });
    mockApi({
      'GET /api/events/monsoon-static': [200, { event }],
      [`GET /api/events/${EVENT_ID}/seats`]: [200, makeSnapshot({ serverTime: iso(serverNow) })],
    });
    renderWithProviders(
      <Routes>
        <Route path="/events/:slug" element={<Event />} />
      </Routes>,
      { route: '/events/monsoon-static', user: FAN },
    );

    const timer = await screen.findByRole('timer', { name: 'Time until the sale opens' });
    expect(timer.textContent).toMatch(/^0(3:00|2:5\d)$/);
  });
});
