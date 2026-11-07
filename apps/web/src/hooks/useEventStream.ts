import type { SeatChange, SeatSnapshot } from '@seatlock/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { applySeatChanges, seatsQueryKey } from './useSeatSnapshot';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** 1 s, 2 s, 4 s ... up to 30 s, each scaled by a random 50-100 %. */
function backoff(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  // Jitter, so thousands of browsers don't reconnect in the same instant after a restart.
  return ceiling * (0.5 + Math.random() * 0.5);
}

/**
 * Keeps the seat snapshot of `eventId` live over SSE (pass undefined to stay disconnected).
 *
 * Seat changes are patched into the snapshot in the query cache. Whenever changes could have
 * been missed (the stream (re)connects, or a hidden tab becomes visible) the snapshot is
 * fetched again, so the map never shows stale seats.
 */
export function useEventStream(eventId: string | undefined): StreamStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    if (!eventId) return;
    const queryKey = seatsQueryKey(eventId);
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let resyncsInFlight = 0;
    let missed: SeatChange[] = [];

    const apply = (changes: SeatChange[]) =>
      queryClient.setQueryData<SeatSnapshot>(queryKey, (snapshot) => snapshot && applySeatChanges(snapshot, changes));

    // The server may have read the re-fetched snapshot before a change that the stream delivers
    // while the request is still in flight; the response would then overwrite that change. So
    // changes received meanwhile are applied again on top of the new snapshot. Re-applying one the
    // snapshot already has is harmless, and later changes arrive after it in order.
    const resync = async () => {
      resyncsInFlight++;
      try {
        await queryClient.invalidateQueries({ queryKey, exact: true });
      } finally {
        if (--resyncsInFlight === 0 && missed.length > 0) {
          apply(missed);
          missed = [];
        }
      }
    };

    const connect = () => {
      const es = new EventSource(`/api/events/${eventId}/stream`);
      source = es;
      es.onopen = () => {
        attempt = 0;
        setStatus('live');
        // A snapshot requested before the stream was registered can miss changes made in between.
        void resync();
      };
      es.onerror = () => {
        // EventSource retries on a fixed delay, and not at all after some failures, so we close
        // it and reconnect ourselves with backoff.
        es.close();
        setStatus('reconnecting');
        retryTimer = setTimeout(connect, backoff(attempt++));
      };
      es.addEventListener('seats', (e: MessageEvent<string>) => {
        const { changes } = JSON.parse(e.data) as { changes: SeatChange[] };
        if (resyncsInFlight > 0) missed.push(...changes);
        apply(changes);
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void resync();
    };

    setStatus('connecting');
    connect();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(retryTimer);
      source?.close();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [eventId, queryClient]);

  return status;
}
