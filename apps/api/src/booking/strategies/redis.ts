import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { isRetryable } from '../../db';
import { claimIfAvailable } from './conditional';
import { holdInTx, peekPreviousHold } from '../seats';
import type { FreedSeat, HoldStrategy } from './types';

/*
 * The redis strategy puts a gate in front of Postgres: `sl:seat:{eventId}:{seatId}` holds the
 * id of the hold that owns the seat (expiring with the hold) or 'sold'. Under contention the
 * losers are turned away by one Lua call after a single indexed read: they never open a
 * Postgres transaction or take a lock. Winners then run the conditional strategy's transaction,
 * which stays the source of truth.
 */

export const seatKey = (eventId: string, seatId: number) => `sl:seat:${eventId}:${seatId}`;

// KEYS: seat keys. ARGV[1]: hold id, ARGV[2]: TTL in ms, ARGV[3]: the buyer's current hold id
// (or ''), whose gates this hold may take over, as the other strategies release that hold first.
// Sets all keys or none, atomically. Returns {taken, inherited}: the 1-based indexes of keys
// owned by anyone else, and {index, remaining ms} for each key taken over from ARGV[3], so a
// hold that Postgres then refuses can hand those back.
const CLAIM = `
local taken, inherited = {}, {}
for i, key in ipairs(KEYS) do
  local owner = redis.call('GET', key)
  if owner == ARGV[3] then
    inherited[#inherited + 1] = {i, redis.call('PTTL', key)}
  elseif owner then
    taken[#taken + 1] = i
  end
end
if #taken == 0 then
  for _, key in ipairs(KEYS) do redis.call('SET', key, ARGV[1], 'PX', ARGV[2]) end
end
return {taken, inherited}`;

// Undoes a claim that Postgres refused: each KEYS[i] still owned by ARGV[1] goes back to the
// buyer's previous hold ARGV[2] for ARGV[i + 2] ms, or is deleted when that is 0.
const GIVE_BACK = `
for i, key in ipairs(KEYS) do
  if redis.call('GET', key) == ARGV[1] then
    local ttl = tonumber(ARGV[i + 2])
    if ttl > 0 then redis.call('SET', key, ARGV[2], 'PX', ttl) else redis.call('DEL', key) end
  end
end
return 0`;

// Compare-and-delete: KEYS[i] is deleted only while it still holds ARGV[i], the id of the hold
// that let the seat go. A key another hold has claimed since then is left alone.
const RELEASE = `
local deleted = 0
for i, key in ipairs(KEYS) do
  if redis.call('GET', key) == ARGV[i] then deleted = deleted + redis.call('DEL', key) end
end
return deleted`;

// Compare-and-extend: the keys still owned by hold ARGV[1] get the TTL ARGV[2] (ms).
const EXTEND = `
for _, key in ipairs(KEYS) do
  if redis.call('GET', key) == ARGV[1] then redis.call('PEXPIRE', key, ARGV[2]) end
end
return 0`;

type GateClaim = {
  /** Seat ids whose gates belong to someone else. */
  taken: number[];
  /** Seat id -> when (epoch ms) its gate would have expired under the buyer's previous hold. */
  inherited: Map<number, number>;
};

/** Claims every seat's gate for `holdId`, or none. Gates of `previousHoldId` count as free. */
async function claimSeatGates(
  redis: Redis,
  eventId: string,
  seatIds: number[],
  holdId: string,
  ttlMs: number,
  previousHoldId: string | null,
): Promise<GateClaim> {
  const keys = seatIds.map((id) => seatKey(eventId, id));
  const [taken, inherited] = (await redis.eval(CLAIM, keys.length, ...keys, holdId, ttlMs, previousHoldId ?? '')) as [
    number[],
    [number, number][],
  ];
  const now = Date.now();
  return {
    taken: taken.map((index) => seatIds[index - 1]!),
    inherited: new Map(inherited.map(([index, pttl]) => [seatIds[index - 1]!, now + pttl])),
  };
}

/**
 * Hands a refused claim's gates back: the ones inherited from `restoreTo` go back to it, with
 * the time they had left; every other one, and all of them when `restoreTo` is null, is deleted.
 */
async function giveBackSeatGates(
  redis: Redis,
  eventId: string,
  seatIds: number[],
  holdId: string,
  restoreTo: string | null,
  inherited: Map<number, number>,
): Promise<void> {
  const keys = seatIds.map((id) => seatKey(eventId, id));
  const now = Date.now();
  const ttls = seatIds.map((id) => (restoreTo === null ? 0 : Math.max(0, (inherited.get(id) ?? now) - now)));
  await redis.eval(GIVE_BACK, keys.length, ...keys, holdId, restoreTo ?? '', ...ttls);
}

/** Drops the gates of freed seats, each only if its hold still owns it. */
export async function releaseSeatGates(redis: Redis, seats: FreedSeat[]): Promise<void> {
  if (seats.length === 0) return;
  const keys = seats.map((s) => seatKey(s.eventId, s.id));
  await redis.eval(RELEASE, keys.length, ...keys, ...seats.map((s) => s.holdId));
}

export async function extendSeatGates(
  redis: Redis,
  eventId: string,
  seatIds: number[],
  holdId: string,
  ttlMs: number,
): Promise<void> {
  const keys = seatIds.map((id) => seatKey(eventId, id));
  await redis.eval(EXTEND, keys.length, ...keys, holdId, ttlMs);
}

/** A sold seat stays gated for good: MSET leaves the keys with no expiry. */
export async function markSeatGatesSold(redis: Redis, eventId: string, seatIds: number[]): Promise<void> {
  await redis.mset(Object.fromEntries(seatIds.map((id) => [seatKey(eventId, id), 'sold'])));
}

/** Deletes the gates of these seats whatever they hold (bench reset). */
export async function clearSeatGates(redis: Redis, eventId: string, seatIds: number[]): Promise<void> {
  for (let i = 0; i < seatIds.length; i += 1_000) {
    await redis.unlink(...seatIds.slice(i, i + 1_000).map((id) => seatKey(eventId, id)));
  }
}

export const redis: HoldStrategy = {
  name: 'redis',
  async hold(deps, input) {
    // A plain read is enough: Postgres re-checks the previous hold under lockBuyer, and a stale
    // answer can only cost a false conflict, never a double hold.
    const previousHoldId = await peekPreviousHold(deps.db, input.userId, input.eventId);
    const holdId = randomUUID();
    const claim = await claimSeatGates(
      deps.redis,
      input.eventId,
      input.seatIds,
      holdId,
      input.ttlSec * 1000,
      previousHoldId,
    );
    if (claim.taken.length > 0) return { ok: false, takenSeatIds: claim.taken };

    const giveBack = (restoreTo: string | null) =>
      giveBackSeatGates(deps.redis, input.eventId, input.seatIds, holdId, restoreTo, claim.inherited);
    // The buyer's active holds that this attempt's transaction found and locked.
    const locked = new Set<string>();
    let handedBack = false;
    try {
      return await holdInTx(deps.db, async (c) => {
        locked.clear();
        try {
          return await claimIfAvailable(c, input, 'redis', holdId, (ids) => ids.forEach((id) => locked.add(id)));
        } catch (e) {
          // Postgres said no (a seat sold through another strategy, a payment in flight...). Hand
          // the gates back now, before the rollback. The previous hold gets its own back only if
          // this transaction found it active and locked: then it is still live, and a release or
          // expiry of it waits for this lock and then compare-and-deletes them. In every other
          // case, say it ended after the peek above, they are deleted, never left blocking seats.
          // A deadlock or serialization failure is retried by withTx with the gates kept.
          if (!isRetryable(e)) {
            handedBack = true;
            await giveBack(previousHoldId !== null && locked.has(previousHoldId) ? previousHoldId : null);
          }
          throw e;
        }
      });
    } catch (e) {
      if (!handedBack) await giveBack(null);
      throw e;
    }
  },
};
