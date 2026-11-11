import { createHash, randomBytes } from 'node:crypto';
import { UserSchema, type User } from '@seatlock/shared';
import type { Redis } from 'ioredis';

export type SessionUser = User;

export const SESSION_TTL_SEC = 604_800; // 7 days

/** An opaque session token: 32 random bytes, base64url (43 characters). */
export const newSessionToken = () => randomBytes(32).toString('base64url');

/**
 * Redis key of a session. Only a SHA-256 of the token is stored, so a Redis dump holds no
 * usable tokens. The value is the JSON of the SessionUser.
 */
export const sessionKey = (token: string) => `sl:sess:${createHash('sha256').update(token).digest('hex')}`;

export async function createSession(redis: Redis, user: SessionUser, ttlSec = SESSION_TTL_SEC): Promise<string> {
  const token = newSessionToken();
  const { id, email, name, role } = user;
  await redis.set(sessionKey(token), JSON.stringify({ id, email, name, role }), 'EX', ttlSec);
  return token;
}

export async function getSession(redis: Redis, token: string): Promise<SessionUser | null> {
  const raw = await redis.get(sessionKey(token));
  if (raw === null) return null;
  const parsed = UserSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function destroySession(redis: Redis, token: string): Promise<void> {
  await redis.del(sessionKey(token));
}
