import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sparkline } from '../../src/features/admin/Sparkline';

const points = (d: string) => d.match(/[ML]/g)?.length ?? 0;

describe('Sparkline', () => {
  it('draws a 60-point series as a path with 60 points', () => {
    const values = Array.from({ length: 60 }, (_, i) => (i * 7) % 13);
    const { container } = render(<Sparkline values={values} label="Holds per second, last 60 seconds" />);
    const line = container.querySelector('path[data-role="line"]');
    expect(points(line?.getAttribute('d') ?? '')).toBe(60);
    expect(screen.getByRole('img', { name: 'Holds per second, last 60 seconds' })).toBeTruthy();
  });

  it('stays on screen for an all-zero series', () => {
    const { container } = render(<Sparkline values={new Array<number>(60).fill(0)} label="Quiet" />);
    const d = container.querySelector('path[data-role="line"]')?.getAttribute('d') ?? '';
    expect(d).not.toMatch(/NaN|Infinity/);
  });
});
