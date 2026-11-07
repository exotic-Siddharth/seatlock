import type { MyHold } from '@seatlock/shared';
import type { AppDeps } from '../context';
import type { Queryable } from '../db';
import { AppError } from '../errors';

// Stub: lane B1 implements these. Lane B2 calls them: getActiveHoldForUser for
// SeatSnapshot.myHold, releaseHoldsForEvent for POST /api/admin/events/:id/bench-reset.

/** The user's active, unexpired hold on the event, or null. */
export async function getActiveHoldForUser(_db: Queryable, _userId: string, _eventId: string): Promise<MyHold | null> {
  throw new AppError('INTERNAL', 'not implemented');
}

/** Deletes the event's holds, orders, tickets and intents, frees every seat and clears its Redis seat keys. */
export async function releaseHoldsForEvent(_deps: AppDeps, _eventId: string): Promise<void> {
  throw new AppError('INTERNAL', 'not implemented');
}
