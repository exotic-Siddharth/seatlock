import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { claimIfAvailable } from './conditional';
import { holdInTx } from '../seats';
import type { FreedSeat, HoldResult, HoldStrategy } from './types';

/*
 * The redis strategy puts a gate in front of Postgres: `sl:seat:{eventId}:{seatId}` holds the
 * id of the hold that owns the seat (expiring with the hold) or 'sold'. Under contention the
 * losers are turned away by one Lua call, so only winners reach Postgres, where the same
 * conditional UPDATE as the conditional strategy stays the source of truth.
 */

export const seatKey = (eventId: string, seatId: number) => `sl:seat:${eventId}:${seatId}`;

// KEYS: seat keys. ARGV[1]: hold id, ARGV[2]: TTL in ms. Sets all keys or none, atomically,
// and returns the 1-based indexes of the keys that were already taken.
const CLAIM = `
local taken = {}
for i, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then taken[#taken + 1] = i end
end
if #taken == 0 then
  for _, key in ipairs(KEYS) do redis.call('SET', key, ARGV[1], 'PX', ARGV[2]) end
end
return taken`;

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

/** Claims every seat's gate for `holdId`, or none; returns the seat ids that were taken. */
export async function claimSeatGates(
  redis: Redis,
  eventId: string,
  seatIds: number[],
  holdId: string,
  ttlMs: number,
): Promise<number[]> {
  const keys = seatIds.map((id) => seatKey(eventId, id));
  const taken = (await redis.eval(CLAIM, keys.length, ...keys, holdId, ttlMs)) as number[];
  return taken.map((index) => seatIds[index - 1]!);
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
    const holdId = randomUUID();
    const taken = await claimSeatGates(deps.redis, input.eventId, input.seatIds, holdId, input.ttlSec * 1000);
    if (taken.length > 0) return { ok: false, takenSeatIds: taken };

    const ownGates = input.seatIds.map((id) => ({ id, eventId: input.eventId, holdId }));
    let result: HoldResult;
    try {
      result = await holdInTx(deps.db, (c) => claimIfAvailable(c, input, 'redis', holdId));
    } catch (e) {
      await releaseSeatGates(deps.redis, ownGates);
      throw e;
    }
    // Postgres said no (say, the seat was sold through another strategy): give the gates back.
    if (!result.ok) await releaseSeatGates(deps.redis, ownGates);
    return result;
  },
};
