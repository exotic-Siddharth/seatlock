import type { User } from '@seatlock/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { Poster } from '../../src/components/layout/Poster';
import { renderWithProviders } from '../render';

const fan: User = { id: '6f1c7a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', email: 'fan@test.dev', name: 'Asha Fan', role: 'user' };
const admin: User = { ...fan, name: 'Ravi Admin', role: 'admin' };

const navLinks = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((a) => a.textContent);

describe('AppShell', () => {
  it('shows the public nav and sign-in links to a guest', async () => {
    renderWithProviders(<App />);
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expect(navLinks()).toEqual(['Events', 'My tickets', 'Lab']);
    expect(screen.getByRole('link', { name: 'Log in' })).toBeTruthy();
  });

  it('adds the Admin link and a log-out button for an admin', async () => {
    renderWithProviders(<App />, { user: admin });
    await screen.findByRole('heading', { level: 1 });
    expect(navLinks()).toEqual(['Events', 'My tickets', 'Lab', 'Admin']);
    expect(screen.getByText('Ravi Admin')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
  });

  it('renders the 404 page for unknown paths', async () => {
    renderWithProviders(<App />, { route: '/no/such/page' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});

describe('route guards', () => {
  it('sends a guest to log in, remembering where they were going', async () => {
    renderWithProviders(<App />, { route: '/tickets' });
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy();
  });

  it('lets a signed-in user through', async () => {
    renderWithProviders(<App />, { route: '/tickets', user: fan });
    expect(await screen.findByRole('heading', { name: 'My tickets' })).toBeTruthy();
  });

  it('keeps non-admins out of admin pages', async () => {
    renderWithProviders(<App />, { route: '/admin', user: fan });
    expect(await screen.findByText('Admins only')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Admin: events' })).toBeNull();
  });

  it('lets admins into admin pages', async () => {
    renderWithProviders(<App />, { route: '/admin/checkin', user: admin });
    expect(await screen.findByRole('heading', { name: 'Admin: check-in' })).toBeTruthy();
  });
});

describe('Poster', () => {
  it('is an image labelled with the title, and is deterministic', () => {
    const { container, unmount } = renderWithProviders(<Poster title="Monsoon Static" hue={210} category="music" />);
    const poster = screen.getByRole('img', { name: 'Monsoon Static poster' });
    expect(within(poster).getByText('Monsoon Static')).toBeTruthy();
    const first = container.querySelector('svg')!.innerHTML.replace(/id="[^"]*"|url\(#[^)]*\)/g, '');
    unmount();
    const again = renderWithProviders(<Poster title="Monsoon Static" hue={210} category="music" />);
    expect(again.container.querySelector('svg')!.innerHTML.replace(/id="[^"]*"|url\(#[^)]*\)/g, '')).toBe(first);
  });
});
