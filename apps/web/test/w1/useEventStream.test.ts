import type { SeatSnapshot } from '@seatlock/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream } from '../../src/hooks/useEventStream';
import { seatsQueryKey, useSeatSnapshot } from '../../src/hooks/useSeatSnapshot';
import { createQueryClient } from '../../src/lib/queryClient';
import { EVENT_ID, makeSeats, makeSnapshot } from './fixtures';
import { MockEventSource, installEventSource, mockApi } from './mocks';

const SNAPSHOT_ROUTE = `GET /api/events/${EVENT_ID}/seats`;

function renderLiveSeats(snapshots: SeatSnapshot[]) {
  let served = 0;
  const http = mockApi({
    // Each request gets the next snapshot; the last one repeats.
    [SNAPSHOT_ROUTE]: () => [200, snapshots[Math.min(served++, snapshots.length - 1)]],
  });
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(() => ({ snapshot: useSeatSnapshot(EVENT_ID), stream: useEventStream(EVENT_ID) }), { wrapper });
  // Both read the query cache, which the hook writes to; a render only reflects the result
  // props that were read before it happened.
  const seats = () => client.getQueryData<SeatSnapshot>(seatsQueryKey(EVENT_ID))?.seats;
  const snapshotFetches = () => http.callsTo(SNAPSHOT_ROUTE).length;
  const fetching = () => client.isFetching({ queryKey: seatsQueryKey(EVENT_ID) }) > 0;
  return { ...hook, seats, snapshotFetches, fetching };
}

/** Opens the stream and waits for the re-sync it triggers. */
async function connect(live: ReturnType<typeof renderLiveSeats>, source = MockEventSource.latest()) {
  const before = live.snapshotFetches();
  act(() => source.open());
  await waitFor(() => expect(live.snapshotFetches()).toBe(before + 1));
  await waitFor(() => expect(live.fetching()).toBe(false));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  installEventSource();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useEventStream', () => {
  it('applies seat changes', async () => {
    const live = renderLiveSeats([makeSnapshot()]);
    await waitFor(() => expect(live.seats()).toHaveLength(16));
    expect(MockEventSource.latest().url).toBe(`/api/events/${EVENT_ID}/stream`);
    await connect(live);
    expect(live.result.current.stream).toBe('live');

    const before = live.seats()!;
    act(() => MockEventSource.latest().emit('seats', { changes: [{ id: 2, st: 'H' }, { id: 5, st: 'S' }] }));

    const after = live.seats()!;
    expect(after[1]![5]).toBe('H');
    expect(after[4]![5]).toBe('S');
    // Untouched seats keep their identity, so their memoised map circles don't re-render.
    expect(after[0]).toBe(before[0]);
    expect(after[15]).toBe(before[15]);
  });

  it('refetches snapshot after reconnect', async () => {
    const live = renderLiveSeats([makeSnapshot(), makeSnapshot(), makeSnapshot({ seats: makeSeats({ 3: 'S' }) })]);
    await waitFor(() => expect(live.seats()).toHaveLength(16));
    await connect(live);

    // The connection drops: while it is down, seat 3 is sold and the change is never delivered.
    act(() => MockEventSource.latest().fail());
    expect(live.result.current.stream).toBe('reconnecting');
    expect(MockEventSource.latest().readyState).toBe(2);

    act(() => vi.advanceTimersByTime(1_000));
    expect(MockEventSource.instances).toHaveLength(2);
    await connect(live, MockEventSource.instances[1]);

    expect(live.seats()![2]![5]).toBe('S');
    expect(live.result.current.stream).toBe('live');
  });

  it('backs off exponentially while the server stays unreachable', () => {
    renderLiveSeats([makeSnapshot()]);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const count = MockEventSource.instances.length;
      act(() => MockEventSource.latest().fail());
      let waited = 0;
      while (MockEventSource.instances.length === count) {
        act(() => vi.advanceTimersByTime(100));
        waited += 100;
      }
      delays.push(waited);
    }
    // Jittered between half and all of 1 s, 2 s, 4 s, 8 s.
    [1_000, 2_000, 4_000, 8_000].forEach((max, i) => {
      expect(delays[i]).toBeGreaterThanOrEqual(max / 2);
      expect(delays[i]).toBeLessThanOrEqual(max);
    });
  });

  it('refetches the snapshot when a hidden tab becomes visible again', async () => {
    const live = renderLiveSeats([makeSnapshot()]);
    await waitFor(() => expect(live.seats()).toHaveLength(16));
    await connect(live);
    const before = live.snapshotFetches();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(live.snapshotFetches()).toBe(before + 1));
  });

  it('re-applies changes that arrive while the snapshot is being re-fetched', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let requests = 0;
    mockApi({
      [SNAPSHOT_ROUTE]: async () => {
        // The second request (the re-sync after connecting) was read on the server before seat 7 was held.
        if (++requests === 2) await gate;
        return [200, makeSnapshot()];
      },
    });
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => ({ snapshot: useSeatSnapshot(EVENT_ID), stream: useEventStream(EVENT_ID) }), { wrapper });
    await waitFor(() => expect(result.current.snapshot.data).toBeDefined());

    act(() => MockEventSource.latest().open());
    await waitFor(() => expect(requests).toBe(2));
    act(() => MockEventSource.latest().emit('seats', { changes: [{ id: 7, st: 'H' }] }));
    await act(async () => release());

    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(client.getQueryData<SeatSnapshot>(seatsQueryKey(EVENT_ID))!.seats[6]![5]).toBe('H');
  });

  it('closes the stream on unmount', () => {
    const live = renderLiveSeats([makeSnapshot()]);
    live.unmount();
    expect(MockEventSource.latest().readyState).toBe(2);
  });
});
