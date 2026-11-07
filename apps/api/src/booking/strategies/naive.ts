import { EFFECTIVE_STATUS_SQL } from '../../events/status';
import { insertHold, markSeatsHeld, releasePreviousHold } from '../seats';
import type { HoldStrategy } from './types';

/**
 * The bug most first versions ship (bench mode only): check, then write, with no transaction,
 * no lock and no condition on the write. Two buyers can both pass the check before either
 * writes, and the second write silently takes the seat from the first. The benchmarks run it
 * to show what the other strategies prevent; the UNIQUE ticket constraint still stops a
 * double sale at payment time.
 */
export const naive: HoldStrategy = {
  name: 'naive',
  async hold(deps, input) {
    const freed = await releasePreviousHold(deps.db, input.userId, input.eventId);
    const { rows } = await deps.db.query<{ id: number; status: string }>(
      `SELECT id, ${EFFECTIVE_STATUS_SQL('')} AS status FROM event_seats WHERE event_id = $1 AND id = ANY($2)`,
      [input.eventId, input.seatIds],
    );
    const taken = rows.filter((r) => r.status !== 'available').map((r) => r.id);
    if (taken.length > 0) return { ok: false, takenSeatIds: taken };

    const hold = await insertHold(deps.db, input, 'naive');
    await markSeatsHeld(deps.db, hold);
    return { ok: true, hold, freed };
  },
};
