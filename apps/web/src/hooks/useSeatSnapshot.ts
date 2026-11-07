import type { SeatChange, SeatSnapshot, SeatTuple } from '@seatlock/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export const seatsQueryKey = (eventId: string) => ['seats', eventId] as const;

/**
 * The event's seats with their effective statuses, plus the caller's active hold.
 * useEventStream keeps it current, so it never goes stale on its own.
 */
export function useSeatSnapshot(eventId: string | undefined) {
  return useQuery({
    queryKey: seatsQueryKey(eventId ?? ''),
    queryFn: ({ signal }) => api<SeatSnapshot>(`/api/events/${eventId}/seats`, { signal }),
    enabled: Boolean(eventId),
    staleTime: Infinity,
  });
}

/**
 * The snapshot with `changes` applied. Seats that did not change keep their tuple, so a
 * memoised seat component re-renders only when its own seat changes.
 */
export function applySeatChanges(snapshot: SeatSnapshot, changes: SeatChange[]): SeatSnapshot {
  const next = new Map(changes.map((c) => [c.id, c.st]));
  let changed = false;
  const seats = snapshot.seats.map((seat): SeatTuple => {
    const st = next.get(seat[0]);
    if (st === undefined || st === seat[5]) return seat;
    changed = true;
    return [seat[0], seat[1], seat[2], seat[3], seat[4], st];
  });
  return changed ? { ...snapshot, seats } : snapshot;
}
