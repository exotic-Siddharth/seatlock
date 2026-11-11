import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Login, { safeNext } from '../../src/pages/Login';
import Register from '../../src/pages/Register';
import { renderWithProviders } from '../render';
import { FAN } from './fixtures';
import { mockApi } from './mocks';

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="location">{pathname + search}</p>;
}

function renderAt(route: string) {
  renderWithProviders(
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </>,
    { route },
  );
  return userEvent.setup();
}
const location = () => screen.getByTestId('location').textContent;

afterEach(() => vi.unstubAllGlobals());

describe('safeNext', () => {
  it.each(['/', '/tickets', '/events/x?y=1', '/events/x?y=1#z', '/orders/abc#tickets', '/events?q=a%20b'])(
    'keeps the same-site path %s unchanged',
    (path) => {
      expect(safeNext(path)).toBe(path);
    },
  );

  it.each([
    ['nothing', null],
    ['an empty string', ''],
    ['a relative path', 'tickets'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash', '/\\evil.example'],
    ['an absolute URL', 'https://evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    // Browsers drop tab, CR and LF from URLs, which turns these into //evil.example.
    ['a tab', '/\t/evil.example'],
    ['a newline', '/\n/evil.example'],
    ['a carriage return', '/\r/evil.example'],
    ['another control character', '/\u0000/evil.example'],
    ['an encoded tab', '/%09/evil.example'],
    ['an encoded slash', '/%2F/evil.example'],
    ['an encoded backslash', '/%5C/evil.example'],
    ['malformed percent-encoding', '/%E0%A4%A'],
    // Resolving dot segments turns each of these into the path //evil.example.
    ['a dot segment before //', '/.//evil.example'],
    ['a parent segment before //', '/..//evil.example'],
    ['an encoded dot segment before //', '/%2e//evil.example'],
    ['a segment undone by .. before //', '/a/..//evil.example'],
    ['dot segments before an encoded slash', '/a/../%2Fevil.example'],
  ])('rejects %s', (_, unsafe) => {
    expect(safeNext(unsafe)).toBe('/');
  });
});

describe('Login', () => {
  it('logs in and returns to the page the guest came from', async () => {
    const http = mockApi({ 'POST /api/auth/login': [200, { user: FAN }] });
    const user = renderAt('/login?next=%2Ftickets');
    await user.type(screen.getByLabelText('Email'), 'fan@test.dev');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(location()).toBe('/tickets'));
    expect(http.callsTo('POST /api/auth/login')[0]!.body).toEqual({ email: 'fan@test.dev', password: 'correct horse' });
  });

  it('ignores a next that points off-site', async () => {
    mockApi({ 'POST /api/auth/login': [200, { user: FAN }] });
    const user = renderAt('/login?next=%2F%2Fevil.example');
    await user.type(screen.getByLabelText('Email'), 'fan@test.dev');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(location()).toBe('/'));
  });

  it('stays on the site when next hides a tab', async () => {
    mockApi({ 'POST /api/auth/login': [200, { user: FAN }] });
    const user = renderAt(`/login?next=${encodeURIComponent('/\t/evil.example')}`);
    await user.type(screen.getByLabelText('Email'), 'fan@test.dev');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(location()).toBe('/'));
  });

  it('shows wrong credentials as a form error', async () => {
    mockApi({ 'POST /api/auth/login': [401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }] });
    const user = renderAt('/login');
    await user.type(screen.getByLabelText('Email'), 'fan@test.dev');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('That email and password do not match an account.')).toBeTruthy();
  });

  it('signs in as the demo user in one click', async () => {
    mockApi({ 'POST /api/auth/demo': [200, { user: { ...FAN, name: 'Demo Fan' } }] });
    const user = renderAt('/login?next=%2Fevents%2Fmonsoon-static');
    await user.click(screen.getByRole('button', { name: 'Try the demo' }));
    await waitFor(() => expect(location()).toBe('/events/monsoon-static'));
  });

  it('keeps next on the link to the register page', () => {
    renderAt('/login?next=%2Ftickets');
    expect(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe('/register?next=%2Ftickets');
  });
});

describe('Register', () => {
  it('validates before sending and shows a taken email on its field', async () => {
    const http = mockApi({ 'POST /api/auth/register': [409, { error: { code: 'EMAIL_TAKEN', message: 'Email already registered' } }] });
    const user = renderAt('/register');
    await user.type(screen.getByLabelText('Name'), 'Asha');
    await user.type(screen.getByLabelText('Email'), 'fan@test.dev');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 10 characters')).toBeTruthy();
    expect(http.calls).toHaveLength(0);

    await user.type(screen.getByLabelText('Password'), ' and longer');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('An account with this email already exists.')).toBeTruthy();
  });

  it('creates the account and goes to next', async () => {
    mockApi({ 'POST /api/auth/register': [201, { user: FAN }] });
    const user = renderAt('/register?next=%2Ftickets');
    await user.type(screen.getByLabelText('Name'), 'Asha Fan');
    await user.type(screen.getByLabelText('Email'), 'fan@test.dev');
    await user.type(screen.getByLabelText('Password'), 'a long passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(location()).toBe('/tickets'));
  });
});
