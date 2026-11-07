import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B1 implements the hold-expiry sweeper (spec §7.3): every 5 s, on the leader only
// (infra/leader.ts runAsLeader).

/** Starts the sweeper; returns a function that stops it. */
export function startSweeper(_deps: AppDeps): () => void {
  return () => {};
}

/** Expires lapsed holds once; returns the number of seats freed. */
export async function sweepOnce(_deps: AppDeps): Promise<number> {
  throw new AppError('INTERNAL', 'not implemented');
}
