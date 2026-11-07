import type { SeatChange } from '@seatlock/shared';
import type { Redis } from 'ioredis';

/** Redis pub/sub channel carrying an event's seat changes. */
export const seatChannel = (eventId: string) => `sl:ev:${eventId}`;

export interface SeatPublisher {
  /** Call after the transaction that changed the seats has committed. */
  publish(eventId: string, changes: SeatChange[]): Promise<void>;
}

export function createSeatPublisher(redis: Redis): SeatPublisher {
  return {
    async publish(eventId, changes) {
      if (changes.length === 0) return;
      await redis.publish(seatChannel(eventId), JSON.stringify({ changes }));
    },
  };
}
