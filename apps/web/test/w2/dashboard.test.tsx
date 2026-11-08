import type { Dashboard, User } from '@seatlock/shared';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminDashboard from '../../src/pages/admin/AdminDashboard';
import { renderWithProviders } from '../render';
import { makeEvent } from '../w1/fixtures';
import { mockApi } from '../w1/mocks';

const admin: User = { id: '6f1c7a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', email: 'a@test.dev', name: 'Ravi Admin', role: 'admin' };
const EVENT_ID = 'e1e2e3e4-0000-4000-8000-000000000001';

function dashboard(queue: Dashboard['queue']): Dashboard {
  const { description: _d, maxSeatsPerOrder: _m, holdTtlSeconds: _h, admitRatePerSec: _a, tierPrices: _t, layout: _l, serverTime: _s, ...event } =
    makeEvent({ id: EVENT_ID, queueEnabled: queue !== null });
  return {
    event,
    counts: { available: 10, held: 2, sold: 4, total: 16 },
    revenuePaise: 0,
    ordersPaid: 0,
    ordersFailed: 0,
    ordersPending: 0,
    activeHolds: 1,
    queue,
    holdsPerSecond: Array.from({ length: 60 }, () => 0),
    recentOrders: [],
  };
}

const renderDashboard = () =>
  renderWithProviders(
    <Routes>
      <Route path="/admin/events/:id" element={<AdminDashboard />} />
    </Routes>,
    { route: `/admin/events/${EVENT_ID}`, user: admin },
  );

afterEach(() => vi.unstubAllGlobals());

describe('Admin dashboard demo tools', () => {
  it('offers Simulate crowd on an event with a waiting room', async () => {
    mockApi({ [`GET /api/admin/events/${EVENT_ID}/dashboard`]: [200, dashboard({ length: 5, admitted: 0, simulated: 0 })] });
    renderDashboard();
    expect(await screen.findByRole('button', { name: 'Simulate crowd' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reopen sale' })).toBeTruthy();
  });

  it('hides Simulate crowd where it could only fail: an event without a waiting room', async () => {
    mockApi({ [`GET /api/admin/events/${EVENT_ID}/dashboard`]: [200, dashboard(null)] });
    renderDashboard();
    expect(await screen.findByRole('button', { name: 'Reopen sale' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Simulate crowd' })).toBeNull();
  });
});
