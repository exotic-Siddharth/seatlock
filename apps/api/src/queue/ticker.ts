import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B2 implements the admission ticker: every 1 s, on the leader only
// (infra/leader.ts runAsLeader), admit `admit_rate_per_sec` more people per on-sale queue event.

/** Starts the ticker; returns a function that stops it. */
export function startQueueTicker(_deps: AppDeps): () => void {
  return () => {};
}

export async function tickQueuesOnce(_deps: AppDeps): Promise<void> {
  throw new AppError('INTERNAL', 'not implemented');
}
