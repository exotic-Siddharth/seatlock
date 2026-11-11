import { randomUUID } from 'node:crypto';
import type { QueueState, QueueStatus } from '@seatlock/shared';
import type { AppDeps } from '../context';
import type { Queryable } from '../db';
import { isUuid } from '../events/queries';
import { signQueueToken } from './token';

/*
 * The waiting room (spec §8). Redis layout for event e:
 *   sl:q:{e}            ZSET  member userId -> score. Lottery scores are random() in [0,1) for people who
 *                       join before the sale opens; later joiners get 1 + INCR(seq), so they queue FIFO behind.
 *   sl:q:{e}:seq        arrival counter for the FIFO scores
 *   sl:q:{e}:admitted   how many people from the front of the ZSET are admitted (raised by the ticker)
 *   sl:q:{e}:tok:{u}    expiry (epoch ms) of the user's access token, fixed at first issue (SET NX)
 *   sl:q:{e}:sim        how many simulated demo members were added
 * A user is admitted while ZRANK < admitted.
 */

/** The event fields the waiting room needs. */
export type QueueEvent = {
  id: string;
  queueEnabled: boolean;
  saleOpensAt: Date;
  startsAt: Date;
  admitRatePerSec: number;
};

const JOIN_LEAD_MS = 10 * 60_000; // the room opens this long before the sale
const ACCESS_WINDOW_MS = 15 * 60_000; // how long an admitted user can pick seats
export const QUEUE_KEY_TTL_SEC = 24 * 60 * 60; // abandoned queues clean themselves up

export const queueKeys = (eventId: string) => ({
  queue: `sl:q:${eventId}`,
  seq: `sl:q:${eventId}:seq`,
  admitted: `sl:q:${eventId}:admitted`,
  simulated: `sl:q:${eventId}:sim`,
});
const tokenKey = (eventId: string, userId: string) => `sl:q:${eventId}:tok:${userId}`;

export async function getQueueEvent(db: Queryable, eventId: string): Promise<QueueEvent | null> {
  if (!isUuid(eventId)) return null;
  const { rows } = await db.query<{
    id: string;
    queue_enabled: boolean;
    sale_opens_at: Date;
    starts_at: Date;
    admit_rate_per_sec: number;
  }>('SELECT id, queue_enabled, sale_opens_at, starts_at, admit_rate_per_sec FROM events WHERE id = $1', [eventId]);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        queueEnabled: row.queue_enabled,
        saleOpensAt: row.sale_opens_at,
        startsAt: row.starts_at,
        admitRatePerSec: row.admit_rate_per_sec,
      }
    : null;
}

type Phase = 'off' | 'not_open' | 'open';

function phaseOf(event: QueueEvent, now: number): Phase {
  if (!event.queueEnabled || now >= event.startsAt.getTime()) return 'off';
  return now < event.saleOpensAt.getTime() - JOIN_LEAD_MS ? 'not_open' : 'open';
}

function makeStatus(
  event: QueueEvent,
  now: number,
  state: QueueState,
  extra: Partial<QueueStatus> = {},
): QueueStatus {
  return {
    state,
    position: null,
    aheadCount: null,
    queueLength: 0,
    admitRatePerSec: event.admitRatePerSec,
    estimatedWaitSec: null,
    saleOpensAt: event.saleOpensAt.toISOString(),
    joinOpensAt: new Date(event.saleOpensAt.getTime() - JOIN_LEAD_MS).toISOString(),
    token: null,
    tokenExpiresAt: null,
    serverTime: new Date(now).toISOString(),
    ...extra,
  };
}

export async function getQueueStatus(deps: AppDeps, event: QueueEvent, userId: string): Promise<QueueStatus> {
  const now = Date.now();
  const phase = phaseOf(event, now);
  if (phase === 'off') return makeStatus(event, now, 'not_required');
  if (phase === 'not_open') return makeStatus(event, now, 'not_open');

  const keys = queueKeys(event.id);
  const [rank, queueLength, admittedRaw] = await Promise.all([
    deps.redis.zrank(keys.queue, userId),
    deps.redis.zcard(keys.queue),
    deps.redis.get(keys.admitted),
  ]);
  if (rank === null) return makeStatus(event, now, 'not_joined', { queueLength });

  const admitted = Number(admittedRaw ?? 0);
  if (rank >= admitted) {
    const position = rank - admitted + 1;
    return makeStatus(event, now, 'waiting', {
      position,
      aheadCount: position - 1,
      queueLength,
      estimatedWaitSec: Math.ceil(position / event.admitRatePerSec),
    });
  }

  // Admitted. The expiry is fixed by the first poll that sees the admission (SET NX), so polling
  // again never extends the window. SET ... NX GET returns the existing value if there is one.
  const exp = now + ACCESS_WINDOW_MS;
  const existing = await deps.redis.set(tokenKey(event.id, userId), String(exp), 'EX', QUEUE_KEY_TTL_SEC, 'NX', 'GET');
  const tokenExp = existing === null ? exp : Number(existing);
  if (tokenExp <= now) return makeStatus(event, now, 'expired', { queueLength });

  return makeStatus(event, now, 'admitted', {
    queueLength,
    token: signQueueToken(deps.config.queueTokenSecret, { e: event.id, u: userId, exp: tokenExp, s: event.saleOpensAt.getTime() }),
    tokenExpiresAt: new Date(tokenExp).toISOString(),
  });
}

// One atomic step, so two requests cannot both pass the "not in the queue yet" check.
// KEYS: queue, seq, admitted, token. ARGV: userId, now (ms), early ('1' before the sale opens),
// random lottery score, ttl (s).
const JOIN = `
local queue, seq, admitted, tok = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local user = ARGV[1]
local exp = redis.call('GET', tok)
if exp and tonumber(exp) <= tonumber(ARGV[2]) then
  -- The access window is over: give up the old place and queue again at the back. If the old place was
  -- inside the admitted range, shrink that range too, or the next person in line would be admitted early.
  local rank = redis.call('ZRANK', queue, user)
  if rank and rank < tonumber(redis.call('GET', admitted) or '0') then redis.call('DECR', admitted) end
  redis.call('ZREM', queue, user)
  redis.call('DEL', tok)
end
if not redis.call('ZSCORE', queue, user) then
  local score = tonumber(ARGV[4])
  if ARGV[3] ~= '1' then score = 1 + redis.call('INCR', seq) end
  redis.call('ZADD', queue, score, user)
end
for _, key in ipairs({queue, seq, admitted}) do redis.call('EXPIRE', key, ARGV[5]) end
return 1`;

/** Joins the room if it is open. Joining again keeps the place; after the token expires it requeues. */
export async function joinQueue(deps: AppDeps, event: QueueEvent, userId: string): Promise<QueueStatus> {
  const now = Date.now();
  if (phaseOf(event, now) === 'open') {
    const keys = queueKeys(event.id);
    const early = now < event.saleOpensAt.getTime();
    await deps.redis.eval(
      JOIN,
      4,
      keys.queue,
      keys.seq,
      keys.admitted,
      tokenKey(event.id, userId),
      userId,
      now,
      early ? '1' : '0',
      Math.random(),
      QUEUE_KEY_TTL_SEC,
    );
  }
  return getQueueStatus(deps, event, userId);
}

/** Adds `n` simulated members (`sim:<uuid>`, labelled as such in the dashboard); returns the new queue length. */
export async function simulateCrowd(deps: AppDeps, eventId: string, n: number): Promise<number> {
  const { rows } = await deps.db.query<{ sale_opens_at: Date }>('SELECT sale_opens_at FROM events WHERE id = $1', [eventId]);
  const saleOpensAt = rows[0]?.sale_opens_at.getTime() ?? 0;
  const keys = queueKeys(eventId);

  // Same scoring as real joins: a lottery before the sale opens, arrival order after.
  const early = Date.now() < saleOpensAt;
  const lastSeq = early ? 0 : await deps.redis.incrby(keys.seq, n);
  const scoreAndMember = Array.from({ length: n }, (_, i): [number, string] => [
    early ? Math.random() : 1 + (lastSeq - n + i + 1), // 1 + the arrival number this member got
    `sim:${randomUUID()}`,
  ]).flat();

  await deps.redis
    .multi()
    .zadd(keys.queue, ...scoreAndMember)
    .incrby(keys.simulated, n)
    .expire(keys.queue, QUEUE_KEY_TTL_SEC)
    .expire(keys.simulated, QUEUE_KEY_TTL_SEC)
    .exec();
  return deps.redis.zcard(keys.queue);
}

/** Size of the queue, how many are admitted, and how many members are simulated. */
export async function getQueueCounters(
  deps: AppDeps,
  eventId: string,
): Promise<{ length: number; admitted: number; simulated: number }> {
  const keys = queueKeys(eventId);
  const [length, admitted, simulated] = await Promise.all([
    deps.redis.zcard(keys.queue),
    deps.redis.get(keys.admitted),
    deps.redis.get(keys.simulated),
  ]);
  return { length, admitted: Number(admitted ?? 0), simulated: Number(simulated ?? 0) };
}

/** Forgets everyone: the queue, its counters and every issued token. */
export async function clearQueue(deps: AppDeps, eventId: string): Promise<void> {
  const keys = queueKeys(eventId);
  await deps.redis.del(keys.queue, keys.seq, keys.admitted, keys.simulated);
  for await (const batch of deps.redis.scanStream({ match: tokenKey(eventId, '*'), count: 500 })) {
    if ((batch as string[]).length > 0) await deps.redis.del(...(batch as string[]));
  }
}
