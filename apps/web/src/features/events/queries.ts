import type { Category, EventDetail, EventSummary, Stats } from '@seatlock/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

export const eventKeys = {
  list: (category: Category | null) => ['events', 'list', category ?? 'all'] as const,
  detail: (slug: string) => ['events', 'detail', slug] as const,
};

export function useEvents(category: Category | null) {
  return useQuery({
    queryKey: eventKeys.list(category),
    queryFn: ({ signal }) =>
      api<{ items: EventSummary[] }>(category ? `/api/events?category=${encodeURIComponent(category)}` : '/api/events', { signal }),
    select: (data) => data.items,
  });
}

/** The event, and when the response arrived (to anchor the server clock). */
export function useEventDetail(slug: string) {
  return useQuery({
    queryKey: eventKeys.detail(slug),
    queryFn: ({ signal }) => api<{ event: EventDetail }>(`/api/events/${encodeURIComponent(slug)}`, { signal }),
    select: (data) => data.event,
  });
}

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: ({ signal }) => api<Stats>('/api/stats', { signal }),
    refetchInterval: 5_000,
  });
}
