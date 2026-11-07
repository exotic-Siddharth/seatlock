import type { AppDeps } from '../context';
import { withTx } from '../db';
import { runAsLeader } from '../infra/leader';
import { afterSeatsChanged, freedChanges } from './holds.service';
import { endHolds } from './seats';
import type { FreedSeat } from './strategies/types';

const SWEEP_EVERY_MS = 5_000;

/** Starts the hold-expiry sweeper on whichever instance holds the leader lock; returns its stop function. */
export function startSweeper(deps: AppDeps): () => void {
  return runAsLeader(deps, 'sweeper', SWEEP_EVERY_MS, async () => {
    await sweepOnce(deps);
  });
}

/**
 * Tidies lapsed holds (spec §7.3): marks them expired and frees their seats. Correctness never
 * waits for this, since every reader already treats a lapsed hold's seats as available; it
 * keeps the tables honest and pushes the freed seats to open seat maps. Returns the seats freed.
 */
export async function sweepOnce(deps: AppDeps): Promise<number> {
  const freed = await withTx(deps.db, async (c) => {
    // An order younger than 60 s may have a payment on its way, so its hold is left alone.
    // SKIP LOCKED: a hold a buyer or a webhook is working on right now waits for the next sweep.
    const { rows } = await c.query<{ id: string }>(
      `SELECT h.id FROM holds h
        WHERE h.status = 'active' AND h.expires_at <= now()
          AND NOT EXISTS (SELECT 1 FROM orders o
                           WHERE o.hold_id = h.id AND o.status = 'pending_payment'
                             AND o.created_at > now() - interval '60 seconds')
          FOR UPDATE SKIP LOCKED`,
    );
    return endHolds(
      c,
      rows.map((r) => r.id),
      'expired',
    );
  });

  const byEvent = new Map<string, FreedSeat[]>();
  for (const seat of freed) byEvent.set(seat.eventId, [...(byEvent.get(seat.eventId) ?? []), seat]);
  await Promise.all([...byEvent].map(([eventId, seats]) => afterSeatsChanged(deps, eventId, freedChanges(seats), seats)));
  return freed.length;
}
