import type { Hold, Order } from '@seatlock/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queueToken } from '../waiting-room/queue';

export const holdKey = (id: string) => ['holds', id] as const;
export const orderKey = (id: string) => ['orders', id] as const;
export const myOrdersKey = ['orders', 'mine'] as const;

export function useHold(id: string) {
  return useQuery({
    queryKey: holdKey(id),
    queryFn: ({ signal }) => api<{ hold: Hold }>(`/api/holds/${id}`, { signal }),
    select: (data) => data.hold,
  });
}

export function useOrder(id: string) {
  return useQuery({
    queryKey: orderKey(id),
    queryFn: ({ signal }) => api<{ order: Order }>(`/api/orders/${id}`, { signal }),
    select: (data) => data.order,
    // While MockPay's webhook is on its way.
    refetchInterval: (query) => (query.state.data?.order.status === 'pending_payment' ? 2_000 : false),
  });
}

export function useMyOrders() {
  return useQuery({
    queryKey: myOrdersKey,
    queryFn: ({ signal }) => api<{ items: Order[] }>('/api/orders', { signal }),
    select: (data) => data.items,
  });
}

/** POST /api/holds, with the waiting-room token when the event has a queue. */
export function useHoldSeats(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (seatIds: number[]) => {
      const token = queueToken.get(eventId);
      return api<{ hold: Hold }>('/api/holds', {
        body: { eventId, seatIds },
        headers: token ? { 'X-Queue-Token': token } : undefined,
      });
    },
    onSuccess: (data) => queryClient.setQueryData(holdKey(data.hold.id), data),
  });
}

export function useReleaseHold(hold: Hold) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/api/holds/${hold.id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.removeQueries({ queryKey: holdKey(hold.id) }),
  });
}
