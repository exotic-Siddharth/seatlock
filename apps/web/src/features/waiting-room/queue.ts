import type { QueueStatus } from '@seatlock/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export const queueKey = (eventId: string) => ['queue', eventId] as const;

const POLL_MS = 3_000;

// sessionStorage: per tab, survives a refresh, gone when the tab closes.
const tokenKey = (eventId: string) => `seatlock:queue-token:${eventId}`;
const startKey = (eventId: string) => `seatlock:queue-start:${eventId}`;

/** The waiting-room access token, sent as X-Queue-Token when holding seats. */
export const queueToken = {
  get: (eventId: string) => sessionStorage.getItem(tokenKey(eventId)),
  clear: (eventId: string) => sessionStorage.removeItem(tokenKey(eventId)),
};

/**
 * How many people were ahead when we first saw our place, so the progress bar survives a
 * refresh. A larger number than before means we rejoined at the back, so it starts over.
 */
export function startingAhead(eventId: string, aheadNow: number): number {
  const stored = Number(sessionStorage.getItem(startKey(eventId)));
  if (stored >= aheadNow && stored > 0) return stored;
  sessionStorage.setItem(startKey(eventId), String(aheadNow));
  return aheadNow;
}

function remember(eventId: string, queue: QueueStatus): QueueStatus {
  if (queue.state === 'admitted' && queue.token) sessionStorage.setItem(tokenKey(eventId), queue.token);
  else queueToken.clear(eventId);
  return queue;
}

const queuePath = (eventId: string) => `/api/events/${eventId}/queue`;

/** The caller's place in the waiting room, polled every 3 s (±20 %) while they wait. */
export function useQueueStatus(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: queueKey(eventId),
    queryFn: async ({ signal }) => remember(eventId, (await api<{ queue: QueueStatus }>(queuePath(eventId), { signal })).queue),
    enabled,
    staleTime: 0,
    // Jitter spreads a crowd's polls out instead of letting them arrive in waves.
    refetchInterval: (query) => (query.state.data?.state === 'waiting' ? POLL_MS * (0.8 + Math.random() * 0.4) : false),
  });
}

/** Joins the line (or rejoins it at the back once an access window has ended). */
export function useJoinQueue(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => remember(eventId, (await api<{ queue: QueueStatus }>(queuePath(eventId), { method: 'POST' })).queue),
    onSuccess: (queue) => queryClient.setQueryData(queueKey(eventId), queue),
  });
}
