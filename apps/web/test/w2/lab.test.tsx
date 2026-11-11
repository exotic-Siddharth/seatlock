import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LabContent } from '../../src/features/lab/LabContent';
import { summaryFixture } from './fixtures';

describe('Lab results', () => {
  it('renders one table per scenario with a row for each of the four strategies', () => {
    render(<LabContent summary={summaryFixture} />);
    for (const name of ['Hot seat results', 'Flash sale results']) {
      const table = screen.getByRole('table', { name });
      expect(within(table).getAllByRole('row').length - 1).toBe(4);
    }
    expect(screen.getAllByRole('table', { name: /results$/ })).toHaveLength(2);
  });

  it('flags runs whose invariants failed and passes the rest', () => {
    render(<LabContent summary={summaryFixture} />);
    const table = screen.getByRole('table', { name: 'Hot seat results' });
    const naive = within(table).getByRole('row', { name: /naive/i });
    expect(within(naive).getByText('Fail')).toBeTruthy();
    expect(within(naive).getByText(/3 oversold/i)).toBeTruthy();
    const conditional = within(table).getByRole('row', { name: /conditional/i });
    expect(within(conditional).getByText('Pass')).toBeTruthy();
    expect(within(table).getAllByText('Fail')).toHaveLength(1);
  });

  it('shows the machine the numbers came from', () => {
    render(<LabContent summary={summaryFixture} />);
    expect(screen.getByText(/Test CPU 9000/)).toBeTruthy();
    expect(screen.getByText(/8 logical cores/)).toBeTruthy();
    expect(screen.getByText(/2 API replicas/)).toBeTruthy();
  });

  it('draws p95 latency and throughput charts with accessible titles', () => {
    render(<LabContent summary={summaryFixture} />);
    expect(screen.getByRole('img', { name: /p95 hold latency.*hot seat/i })).toBeTruthy();
    // Throughput is what each scenario is for, not raw req/s, which 409 retries and polls inflate.
    expect(screen.getByRole('img', { name: /buyers answered per second, hot seat/i })).toBeTruthy();
    expect(screen.getByRole('img', { name: /seats sold per second, flash sale/i })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /^throughput/i })).toBeNull();
  });

  it('gives a clean naive run a neutral Baseline badge, never a green Pass', () => {
    const naiveClean = {
      ...summaryFixture,
      runs: summaryFixture.runs.map((r) =>
        r.strategy === 'naive' ? { ...r, invariants: { ...r.invariants, oversoldSeats: 0, doublePromisedSeats: 3, pass: true } } : r,
      ),
    };
    render(<LabContent summary={naiveClean} />);
    const naive = within(screen.getByRole('table', { name: 'Hot seat results' })).getByRole('row', { name: /naive/i });
    expect(within(naive).getByText('Baseline')).toBeTruthy();
    expect(within(naive).queryByText('Pass')).toBeNull();
    expect(within(naive).getByText(/3 double-promised/)).toBeTruthy();
  });

  it('shows a "Not publishable" banner for a rejected file, and no Pass badge on a run it lists', () => {
    const rejected = {
      ...summaryFixture,
      problems: ['hot-seat/conditional: 0 holds succeeded on the same 4 seats, expected exactly 1', 'queue: 12 of 3000 users were never admitted'],
      warnings: ['flash-sale/redis: 4 of 100 hold requests failed'],
    };
    render(<LabContent summary={rejected} />);

    const banner = screen.getByRole('alert');
    expect(within(banner).getByText(/Not publishable/)).toBeTruthy();
    expect(within(banner).getByText(/0 holds succeeded/)).toBeTruthy();
    expect(within(banner).getByText(/never admitted/)).toBeTruthy();
    expect(screen.getByText('Warnings')).toBeTruthy();
    expect(screen.getByText(/4 of 100 hold requests failed/)).toBeTruthy();

    const table = screen.getByRole('table', { name: 'Hot seat results' });
    const conditional = within(table).getByRole('row', { name: /conditional/i });
    expect(within(conditional).queryByText('Pass')).toBeNull();
    expect(within(conditional).getByText('Rejected')).toBeTruthy();
    // A run the verdict does not mention keeps its badge.
    expect(within(within(table).getByRole('row', { name: /pessimistic/i })).getByText('Pass')).toBeTruthy();
  });

  it('shows no banner for a file that passed its checks', () => {
    render(<LabContent summary={{ ...summaryFixture, problems: [], warnings: [] }} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Warnings')).toBeNull();
  });

  it('describes the queue benchmark as the lottery it is', () => {
    render(<LabContent summary={summaryFixture} />);
    expect(screen.getByText(/places are drawn by lottery/)).toBeTruthy();
    expect(screen.queryByText(/joined earlier/)).toBeNull();
  });

  it('shows the empty state and the command when no results are committed', () => {
    render(<LabContent summary={null} />);
    expect(screen.getByText('No benchmark results committed yet')).toBeTruthy();
    expect(screen.getByText('bash loadtest/run-bench.sh')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('explains all four strategies and the architecture even without results', () => {
    render(<LabContent summary={null} />);
    for (const name of ['naive', 'pessimistic', 'conditional', 'redis']) {
      expect(screen.getByRole('heading', { name: new RegExp(`^${name}`, 'i') })).toBeTruthy();
    }
    expect(screen.getByRole('img', { name: /architecture/i })).toBeTruthy();
  });
});
