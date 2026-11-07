import type { SeatTuple } from '@seatlock/shared';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SeatMap } from '../../src/features/seatmap/SeatMap';
import { useSeatSelection } from '../../src/features/seatmap/useSeatSelection';
import { renderWithProviders } from '../render';
import { LAYOUT, TIER_PRICES, makeSeats } from './fixtures';

const seat = (name: string) => screen.getByRole('button', { name });
const allSeats = () => screen.getAllByRole('button', { name: /, Row / });

function Picker({ max = 6, initial = makeSeats({ 9: 'S', 10: 'H' }) }: { max?: number; initial?: SeatTuple[] }) {
  const [seats, setSeats] = useState(initial);
  const selection = useSeatSelection({ max, seats });
  return (
    <>
      <SeatMap
        layout={LAYOUT}
        seats={seats}
        selected={selection.selected}
        mine={new Set()}
        tierPrices={TIER_PRICES}
        onToggle={selection.toggle}
      />
      <p data-testid="selected">{[...selection.selected].join(',')}</p>
      {/* Stands in for a live update: another buyer holds seat 2. */}
      <button type="button" onClick={() => setSeats((all) => all.map((s) => (s[0] === 2 ? [2, 'A', 'A', 2, 'gold', 'H'] : s)))}>
        someone takes seat 2
      </button>
    </>
  );
}
const selectedIds = () => screen.getByTestId('selected').textContent;

describe('SeatMap', () => {
  it('renders one focusable seat element per seat with a descriptive label', () => {
    renderWithProviders(<Picker />);
    expect(allSeats()).toHaveLength(16);
    for (const el of allSeats()) expect(el.getAttribute('tabindex')).toMatch(/^(0|-1)$/);
    // Exactly one seat is in the tab order; arrow keys move between the rest.
    expect(allSeats().filter((el) => el.getAttribute('tabindex') === '0')).toHaveLength(1);

    expect(seat('Sec A, Row B, Seat 3, Gold, ₹2,499, available')).toBeTruthy();
    expect(seat('Sec B, Row A, Seat 1, Silver, ₹999, sold')).toBeTruthy();
    expect(seat('Sec B, Row A, Seat 2, Silver, ₹999, held')).toBeTruthy();
  });

  it('toggles the focused seat with Enter', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithProviders(
      <SeatMap layout={LAYOUT} seats={makeSeats()} selected={new Set()} mine={new Set()} tierPrices={TIER_PRICES} onToggle={onToggle} />,
    );
    act(() => seat('Sec A, Row B, Seat 3, Gold, ₹2,499, available').focus());
    await user.keyboard('{Enter}');
    expect(onToggle).toHaveBeenCalledWith(7);
  });

  it('moves focus to the neighbouring seat with the arrow keys', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker />);
    act(() => seat('Sec A, Row A, Seat 2, Gold, ₹2,499, available').focus());
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(seat('Sec A, Row A, Seat 3, Gold, ₹2,499, available'));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(seat('Sec A, Row B, Seat 3, Gold, ₹2,499, available'));
    expect(document.activeElement?.getAttribute('tabindex')).toBe('0');
  });

  it('marks sold and held seats aria-disabled and ignores clicks on them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker />);
    const sold = seat('Sec B, Row A, Seat 1, Silver, ₹999, sold');
    expect(sold.getAttribute('aria-disabled')).toBe('true');
    expect(seat('Sec B, Row A, Seat 2, Silver, ₹999, held').getAttribute('aria-disabled')).toBe('true');
    expect(seat('Sec A, Row A, Seat 1, Gold, ₹2,499, available').getAttribute('aria-disabled')).toBeNull();

    await user.click(sold);
    expect(selectedIds()).toBe('');
  });

  it('selects and deselects seats on click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker />);
    await user.click(seat('Sec A, Row A, Seat 1, Gold, ₹2,499, available'));
    expect(selectedIds()).toBe('1');
    const picked = seat('Sec A, Row A, Seat 1, Gold, ₹2,499, selected');
    expect(picked.getAttribute('aria-pressed')).toBe('true');
    await user.click(picked);
    expect(selectedIds()).toBe('');
  });

  it('caps the selection at maxSeatsPerOrder with a toast', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker max={2} />);
    await user.click(seat('Sec A, Row A, Seat 1, Gold, ₹2,499, available'));
    await user.click(seat('Sec A, Row A, Seat 2, Gold, ₹2,499, available'));
    await user.click(seat('Sec A, Row A, Seat 3, Gold, ₹2,499, available'));

    expect(selectedIds()).toBe('1,2');
    expect(await screen.findByText('You can pick up to 2 seats')).toBeTruthy();
  });

  it('deselects a seat another buyer takes, with a toast', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker />);
    await user.click(seat('Sec A, Row A, Seat 1, Gold, ₹2,499, available'));
    await user.click(seat('Sec A, Row A, Seat 2, Gold, ₹2,499, available'));

    await user.click(screen.getByRole('button', { name: 'someone takes seat 2' }));
    expect(selectedIds()).toBe('1');
    expect(await screen.findByText('Seat A2 was just taken.')).toBeTruthy();
  });

  it('flashes the seats named in flashIds', () => {
    renderWithProviders(
      <SeatMap
        layout={LAYOUT}
        seats={makeSeats({ 3: 'H' })}
        selected={new Set()}
        mine={new Set()}
        tierPrices={TIER_PRICES}
        onToggle={() => {}}
        flashIds={new Set([3])}
      />,
    );
    expect(seat('Sec A, Row A, Seat 3, Gold, ₹2,499, held').getAttribute('class')).toContain('seat-flash');
    expect(seat('Sec A, Row A, Seat 4, Gold, ₹2,499, available').getAttribute('class')).not.toContain('seat-flash');
  });

  it('labels the seats of your own hold', () => {
    renderWithProviders(
      <SeatMap layout={LAYOUT} seats={makeSeats({ 4: 'H' })} selected={new Set()} mine={new Set([4])} tierPrices={TIER_PRICES} onToggle={() => {}} />,
    );
    expect(seat('Sec A, Row A, Seat 4, Gold, ₹2,499, held by you').getAttribute('aria-disabled')).toBe('true');
  });

  it('zooms with the + and - buttons by changing the viewBox', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<Picker />);
    const svg = container.querySelector('svg[data-seatmap]')!;
    const width = () => Number(svg.getAttribute('viewBox')!.split(' ')[2]);
    expect(width()).toBe(LAYOUT.width);

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(width()).toBeLessThan(LAYOUT.width);
    await user.click(screen.getByRole('button', { name: 'Show the whole venue' }));
    expect(width()).toBe(LAYOUT.width);
  });

  it('does not toggle a seat at the end of a drag', () => {
    const onToggle = vi.fn();
    const { container } = renderWithProviders(
      <SeatMap layout={LAYOUT} seats={makeSeats()} selected={new Set()} mine={new Set()} tierPrices={TIER_PRICES} onToggle={onToggle} />,
    );
    const svg = container.querySelector('svg[data-seatmap]')!;
    const target = seat('Sec A, Row A, Seat 1, Gold, ₹2,499, available');
    fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 60, clientY: 30 });
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 60, clientY: 30 });
    fireEvent.click(target);
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.click(target);
    expect(onToggle).toHaveBeenCalledWith(1);
  });
});
