import type { StrategyName } from '@seatlock/shared';

export type StrategyInfo = {
  name: StrategyName;
  tagline: string;
  /** Short SQL (or Lua) matching spec section 7.1; the app code between statements is in comments. */
  sql: string;
  language: 'sql' | 'sql + lua';
  pros: string[];
  cons: string[];
  /** Shown as a badge on the card. */
  badge?: { label: string; tone: 'danger' | 'success' };
};

/** `$avail` below stands for: status = 'available' OR (status = 'held' AND held_until <= now()). */
export const STRATEGIES: StrategyInfo[] = [
  {
    name: 'naive',
    tagline: 'Check first, write later, with nothing in between. The bug most first versions ship.',
    language: 'sql',
    sql: `SELECT id, status FROM event_seats
 WHERE id = ANY($ids);
-- app: if any seat is not available, return "taken"

INSERT INTO holds (...) VALUES (...) RETURNING id;

UPDATE event_seats
   SET status = 'held', hold_id = $hold,
       held_until = now() + $ttl
 WHERE id = ANY($ids);        -- no condition, no lock`,
    pros: ['Two statements and no locks: the easiest thing to write.'],
    cons: [
      'Two buyers can both pass the check, then both write. The second UPDATE silently takes the seat from the first.',
      'Only the UNIQUE constraint on tickets stops a double sale, after the customer has already paid and must be refunded.',
    ],
    badge: { label: 'Benchmark only', tone: 'danger' },
  },
  {
    name: 'pessimistic',
    tagline: 'Lock the rows first, then decide. Correct, but waiters queue up behind the lock.',
    language: 'sql',
    sql: `BEGIN;
SELECT id FROM event_seats
 WHERE event_id = $e AND id = ANY($ids)
 ORDER BY id
   FOR UPDATE;                -- lock in id order
-- app: every seat must satisfy $avail

INSERT INTO holds (...) VALUES (...) RETURNING id;
UPDATE event_seats
   SET status = 'held', hold_id = $hold,
       held_until = now() + $ttl
 WHERE id = ANY($ids);
COMMIT;`,
    pros: ['Easy to reason about: once the locks are held nobody else can touch those seats.', 'Locking in id order avoids deadlocks between buyers who want overlapping seats.'],
    cons: ['Every contender waits for the lock, so latency grows with contention.', 'A slow transaction holds connections and blocks everyone behind it.'],
  },
  {
    name: 'conditional',
    tagline: 'One atomic statement: take the seats only if they are still free. The default.',
    language: 'sql',
    sql: `BEGIN;
INSERT INTO holds (...) VALUES (...) RETURNING id;

UPDATE event_seats
   SET status = 'held', hold_id = $hold,
       held_until = now() + $ttl
 WHERE event_id = $e
   AND id = ANY($ids)
   AND $avail                 -- the condition is the lock
RETURNING id;
-- app: fewer rows than requested -> ROLLBACK,
--      report the missing ids as taken
COMMIT;`,
    pros: [
      'No explicit locks and no read-then-write gap: the WHERE clause is the check.',
      'Under READ COMMITTED, Postgres re-checks the WHERE on the newest row version, so exactly one transaction wins each seat.',
    ],
    cons: ['Losers still reach Postgres and roll back, so a hot seat costs a database round trip per contender.'],
    badge: { label: 'Default', tone: 'success' },
  },
  {
    name: 'redis',
    tagline: 'Reject the losers in Redis, before they open a Postgres transaction. Postgres still has the last word.',
    language: 'sql + lua',
    sql: `-- Lua, atomic in Redis. KEYS = sl:seat:{event}:{seat} for each seat
for each key: if EXISTS(key) then return "taken" end
for each key: SET key holdId PX ttl
return "ok"

-- Winners then run the conditional UPDATE in Postgres as a safety net:
UPDATE event_seats
   SET status = 'held', hold_id = $hold,
       held_until = now() + $ttl
 WHERE event_id = $e AND id = ANY($ids) AND $avail
RETURNING id;
-- app: if that fails, release the Redis keys, report "taken"`,
    pros: [
      'Contenders lose fast, in memory: one indexed read of their own hold, then no Postgres transaction or row lock.', 'Postgres still verifies every winner, so a Redis mistake cannot sell a seat twice.'],
    cons: ['Two systems to keep in step: expiries and releases must compare-and-delete the right keys.', 'Adds a Redis round trip for winners, who also pay the Postgres cost.'],
  },
];
