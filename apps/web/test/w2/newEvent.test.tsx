import type { User } from '@seatlock/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toCreateEventInput } from '../../src/features/admin/eventForm';
import AdminNewEvent from '../../src/pages/admin/AdminNewEvent';
import { renderWithProviders } from '../render';
import { venueFixture } from './fixtures';

const admin: User = { id: '6f1c7a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', email: 'a@test.dev', name: 'Ravi Admin', role: 'admin' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

beforeEach(() => {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/admin/venues') return Promise.resolve(json({ items: [venueFixture] }));
    if (url === '/api/admin/events' && init?.method === 'POST') return Promise.resolve(json({ event: { id: 'x', slug: 'new' } }, 201));
    return Promise.resolve(json({ error: { code: 'NOT_FOUND', message: 'no' } }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Title'), 'Midnight Ragas');
  await user.selectOptions(screen.getByLabelText('Venue'), venueFixture.id);
  await user.type(screen.getByLabelText('Event starts'), '2027-03-20T19:30');
  await user.type(screen.getByLabelText('Sale opens'), '2027-03-01T10:00');
}

describe('create event form', () => {
  it('shows the venue capacity and tiers once a venue is chosen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminNewEvent />, { user: admin });
    await user.selectOptions(await screen.findByLabelText('Venue'), venueFixture.id);
    expect(screen.getByText(/480 seats/)).toBeTruthy();
    expect(screen.getByLabelText('Premium price (₹)')).toBeTruthy();
    expect(screen.getByLabelText('Standard price (₹)')).toBeTruthy();
  });

  it('blocks submit until every venue tier has a price', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminNewEvent />, { user: admin });
    await fillBasics(user);
    await user.type(screen.getByLabelText('Premium price (₹)'), '4999');
    await user.click(screen.getByRole('button', { name: 'Create event' }));

    expect(await screen.findByText('Enter a price for Standard')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('sends prices in paise and times as ISO strings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminNewEvent />, { user: admin });
    await fillBasics(user);
    await user.type(screen.getByLabelText('Premium price (₹)'), '4999');
    await user.type(screen.getByLabelText('Standard price (₹)'), '1499.50');
    await user.click(screen.getByRole('button', { name: 'Create event' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = JSON.parse((posts()[0]![1] as RequestInit).body as string);
    expect(body.tierPrices).toEqual({ premium: 499900, standard: 149950 });
    expect(body.venueId).toBe(venueFixture.id);
    expect(body.startsAt).toBe(new Date('2027-03-20T19:30').toISOString());
    expect(body.saleOpensAt).toBe(new Date('2027-03-01T10:00').toISOString());
  });
});

describe('toCreateEventInput', () => {
  it('converts rupees to integer paise', () => {
    const result = toCreateEventInput(
      {
        title: 'Show',
        subtitle: '',
        category: 'music',
        venueId: venueFixture.id,
        startsAt: '2027-03-20T19:30',
        saleOpensAt: '2027-03-01T10:00',
        prices: { premium: '4999', standard: '19.99' },
        queueEnabled: true,
        admitRatePerSec: '25',
      },
      venueFixture,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.tierPrices).toEqual({ premium: 499900, standard: 1999 });
  });
});
