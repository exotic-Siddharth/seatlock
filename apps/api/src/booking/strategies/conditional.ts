import type { StrategyName } from '@seatlock/shared';
import type { Queryable } from '../../db';
import { AVAILABLE_SQL } from '../../events/status';
import { holdInTx, insertHold, lockBuyer, releasePreviousHold, SeatsTaken, stampWon } from '../seats';
import type { HoldInput, HoldStrategy, HoldSuccess } from './types';

/**
 * The conditional strategy's transaction (the redis strategy reuses it as its safety net).
 * The UPDATE takes only seats that are effectively available, all in one statement. Under
 * READ COMMITTED, a writer that finds a row locked waits, then re-checks the WHERE against the
 * newest version of the row, so exactly one transaction wins each seat. Fewer rows than seats
 * asked for means someone else won some of them: roll back, so nothing is half-held.
 */
export async function claimIfAvailable(
  c: Queryable,
  input: HoldInput,
  strategy: StrategyName,
  holdId?: string,
): Promise<HoldSuccess> {
  await lockBuyer(c, input.userId, input.eventId);
  const freed = await releasePreviousHold(c, input.userId, input.eventId);
  const hold = await insertHold(c, input, strategy, holdId);
  const { rows } = await c.query<{ id: number }>(
    `UPDATE event_seats
        SET status = 'held', hold_id = $1, held_until = (SELECT expires_at FROM holds WHERE id = $1), updated_at = now()
      WHERE event_id = $2 AND id = ANY($3) AND ${AVAILABLE_SQL('')}
      RETURNING id`,
    [hold.id, input.eventId, input.seatIds],
  );
  if (rows.length < input.seatIds.length) {
    const won = new Set(rows.map((r) => r.id));
    throw new SeatsTaken(input.seatIds.filter((id) => !won.has(id)));
  }
  // The UPDATE may have waited for another buyer's release to commit: the hold starts now.
  return { ok: true, hold: { ...hold, createdAt: await stampWon(c, hold.id) }, freed };
}

export const conditional: HoldStrategy = {
  name: 'conditional',
  hold: (deps, input) => holdInTx(deps.db, (c) => claimIfAvailable(c, input, 'conditional')),
};
