import { AVAILABLE_SQL } from '../../events/status';
import { holdInTx, insertHold, lockBuyer, markSeatsHeld, releasePreviousHold, SeatsTaken } from '../seats';
import type { HoldStrategy } from './types';

/**
 * Lock first, then decide. SELECT ... FOR UPDATE makes every other buyer of these seats wait
 * for this transaction, and locking in id order means two buyers wanting overlapping seats
 * always queue in the same order, so they can't deadlock each other.
 */
export const pessimistic: HoldStrategy = {
  name: 'pessimistic',
  hold: (deps, input) =>
    holdInTx(deps.db, async (c) => {
      await lockBuyer(c, input.userId, input.eventId);
      const freed = await releasePreviousHold(c, input.userId, input.eventId);
      const { rows } = await c.query<{ id: number; available: boolean }>(
        `SELECT id, ${AVAILABLE_SQL('')} AS available
           FROM event_seats
          WHERE event_id = $1 AND id = ANY($2)
          ORDER BY id
            FOR UPDATE`,
        [input.eventId, input.seatIds],
      );
      const taken = rows.filter((r) => !r.available).map((r) => r.id);
      if (taken.length > 0) throw new SeatsTaken(taken);

      const hold = await insertHold(c, input, 'pessimistic');
      await markSeatsHeld(c, hold); // the rows are locked and checked, so no condition is needed
      return { ok: true, hold, freed };
    }),
};
