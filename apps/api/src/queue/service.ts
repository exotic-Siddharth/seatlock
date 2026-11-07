import type { QueueStatus } from '@seatlock/shared';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B2 implements the waiting room (spec §8). Tokens are signed and checked with
// queue/token.ts; B1's hold pre-check only needs verifyQueueToken from there.

/** The event fields the waiting room needs. */
export type QueueEvent = {
  id: string;
  queueEnabled: boolean;
  saleOpensAt: Date;
  startsAt: Date;
  admitRatePerSec: number;
};

export async function getQueueStatus(_deps: AppDeps, _event: QueueEvent, _userId: string): Promise<QueueStatus> {
  throw new AppError('INTERNAL', 'not implemented');
}

export async function joinQueue(_deps: AppDeps, _event: QueueEvent, _userId: string): Promise<QueueStatus> {
  throw new AppError('INTERNAL', 'not implemented');
}

/** Adds `n` simulated members; returns the new queue length. */
export async function simulateCrowd(_deps: AppDeps, _eventId: string, _n: number): Promise<number> {
  throw new AppError('INTERNAL', 'not implemented');
}

export async function clearQueue(_deps: AppDeps, _eventId: string): Promise<void> {
  throw new AppError('INTERNAL', 'not implemented');
}
