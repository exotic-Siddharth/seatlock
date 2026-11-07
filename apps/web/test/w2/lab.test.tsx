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
    expect(screen.getByRole('img', { name: /throughput.*flash sale/i })).toBeTruthy();
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
