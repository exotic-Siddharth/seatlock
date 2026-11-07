import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerClock, useCountdown } from '../../src/lib/serverClock';

const SERVER_NOW = '2026-11-07T10:00:00.000Z';
const FIVE_MIN = 5 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  // The client's clock runs 5 minutes fast.
  vi.setSystemTime(Date.parse(SERVER_NOW) + FIVE_MIN);
});
afterEach(() => vi.useRealTimers());

describe('createServerClock', () => {
  it('reads server time, not the skewed client clock', () => {
    const clock = createServerClock(SERVER_NOW);
    expect(clock.now()).toBe(Date.parse(SERVER_NOW));
    vi.advanceTimersByTime(1500);
    expect(clock.now()).toBe(Date.parse(SERVER_NOW) + 1500);
  });

  it('accounts for when the response was received', () => {
    const receivedAt = Date.now() - 2000;
    expect(createServerClock(SERVER_NOW, receivedAt).now()).toBe(Date.parse(SERVER_NOW) + 2000);
  });
});

describe('useCountdown', () => {
  const target = new Date(Date.parse(SERVER_NOW) + FIVE_MIN).toISOString();

  it('counts down in server time', () => {
    const clock = createServerClock(SERVER_NOW);
    const { result } = renderHook(() => useCountdown(target, clock));
    expect(result.current).toMatchObject({ mm: '05', ss: '00', done: false });

    act(() => vi.advanceTimersByTime(61_000));
    expect(result.current).toMatchObject({ mm: '03', ss: '59', done: false });

    act(() => vi.advanceTimersByTime(FIVE_MIN));
    expect(result.current).toEqual({ msLeft: 0, mm: '00', ss: '00', done: true });
  });

  it('settles when the clock is recreated on every render', () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useCountdown(target, createServerClock(SERVER_NOW));
    });
    act(() => vi.advanceTimersByTime(3_000));
    expect(renders).toBeLessThan(10);
  });
});
