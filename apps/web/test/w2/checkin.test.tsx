import type { User } from '@seatlock/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminCheckin from '../../src/pages/admin/AdminCheckin';
import { renderWithProviders } from '../render';
import { mockApi } from '../w1/mocks';

const admin: User = { id: '6f1c7a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', email: 'a@test.dev', name: 'Ravi Admin', role: 'admin' };
const CHECKIN = 'POST /api/admin/checkin';
const CODE = 'SL-ABCDEFGHJKMNPQRSTVWX';

afterEach(() => vi.unstubAllGlobals());

async function scan(code = CODE) {
  const user = userEvent.setup();
  renderWithProviders(<AdminCheckin />, { route: '/admin/checkin', user: admin });
  await user.type(screen.getByLabelText('Ticket code'), code);
  await user.click(screen.getByRole('button', { name: 'Check in' }));
}

const codeInput = () => screen.getByLabelText('Ticket code') as HTMLInputElement;

describe('Door check-in', () => {
  it('checks a valid ticket in and clears the box for the next one', async () => {
    mockApi({
      [CHECKIN]: [
        200,
        {
          ticket: { id: 't', code: CODE, seatLabel: 'Sec A · Row A · Seat 1', tier: 'gold', pricePaise: 1, checkedInAt: new Date().toISOString() },
          seatLabel: 'Sec A · Row A · Seat 1',
          eventTitle: 'Monsoon Static',
          alreadyCheckedIn: false,
        },
      ],
    });
    await scan();
    expect(await screen.findByText('Checked in')).toBeTruthy();
    expect(codeInput().value).toBe('');
  });

  it('says "Not valid" only when no ticket has the code', async () => {
    mockApi({ [CHECKIN]: [404, { error: { code: 'NOT_FOUND', message: 'No ticket with this code' } }] });
    await scan();
    expect(await screen.findByText('Not valid')).toBeTruthy();
    expect(screen.getByText('No ticket has that code.')).toBeTruthy();
  });

  it('says "Not valid" for something too long to be a ticket code', async () => {
    mockApi({ [CHECKIN]: [400, { error: { code: 'VALIDATION_FAILED', message: 'code: too long' } }] });
    await scan('X'.repeat(70));
    expect(await screen.findByText('Not valid')).toBeTruthy();
  });

  it.each([
    ['the network is down', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the server fails', [500, { error: { code: 'INTERNAL', message: 'Something broke' } }]],
    ['the session expired', [401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } }]],
    ['the scanner is rate limited', [429, { error: { code: 'RATE_LIMITED', message: 'Slow down' } }]],
    ['the CSRF check fails', [403, { error: { code: 'CSRF_FAILED', message: 'Cross-site request blocked' } }]],
  ] as const)('never turns a ticket holder away when %s: a neutral retry, and the code is kept', async (_, reply) => {
    mockApi({ [CHECKIN]: typeof reply === 'function' ? (reply as () => never) : ([...reply] as [number, unknown]) });
    await scan();
    expect(await screen.findByText('Could not check, try again')).toBeTruthy();
    expect(screen.queryByText('Not valid')).toBeNull();
    expect(codeInput().value).toBe(CODE);
  });
});
