import type { AppDeps } from '../context';
import { withTx } from '../db';
import { runAsLeader } from '../infra/leader';
import { afterSeatsChanged, freedChanges } from './holds.service';
import { closeCheckouts, endHolds, PAYMENT_IN_FLIGHT_SQL } from './seats';
import type { FreedSeat } from './strategies/types';

const SWEEP_EVERY_MS = 5_000;

/** Starts the hold-expiry sweeper on whichever instance holds the leader lock; returns its stop function. */
export function startSweeper(deps: AppDeps): () => void {
  return runAsLeader(deps, 'sweeper', SWEEP_EVERY_MS, async () => {
    await sweepOnce(deps);
  });
}

/**
 * Tidies lapsed holds (spec §7.3): marks them expired, frees their seats and fails their
 * unpaid orders with HOLD_EXPIRED. Correctness never waits for this, since every reader
 * already treats a lapsed hold's seats as available; it keeps the tables honest, ends the
 * checkouts nobody paid for and pushes the freed seats to open seat maps. Returns the seats freed.
 */
export async function sweepOnce(deps: AppDeps): Promise<number> {
  const freed = await withTx(deps.db, async (c) => {
    // §7.3's 60 s grace protects a payment in flight: while the hold's intent has been processing
    // for under 60 s, the hold is left alone, so a webhook arriving after expiry still sells
    // seats nobody took. (Its seats stay lazily available, so a buyer who takes one still wins.)
    // SKIP LOCKED: a hold a buyer or a webhook is working on right now waits for the next sweep.
    const { rows } = await c.query<{ id: string }>(
      `SELECT h.id FROM holds h
        WHERE h.status = 'active' AND h.expires_at <= now()
          AND NOT EXISTS (SELECT 1 FROM orders o JOIN payment_intents pi ON pi.order_id = o.id
                           WHERE o.hold_id = h.id AND o.status = 'pending_payment' AND ${PAYMENT_IN_FLIGHT_SQL('pi')})
          FOR UPDATE SKIP LOCKED`,
    );
    const lapsed = rows.map((r) => r.id);
    // A payment that started after the SELECT above keeps its hold until the next sweep.
    const paying = await closeCheckouts(c, lapsed, 'HOLD_EXPIRED', 'skip');
    return endHolds(
      c,
      lapsed.filter((id) => !paying.has(id)),
      'expired',
    );
  });

  const byEvent = new Map<string, FreedSeat[]>();
  for (const seat of freed) byEvent.set(seat.eventId, [...(byEvent.get(seat.eventId) ?? []), seat]);
  await Promise.all([...byEvent].map(([eventId, seats]) => afterSeatsChanged(deps, eventId, freedChanges(seats), seats)));
  return freed.length;
}
