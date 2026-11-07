import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, destroySession, getSession, type SessionUser } from '../../src/auth/sessions';
import { makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;
const user: SessionUser = { id: randomUUID(), email: 'asha@test.seatlock.dev', name: 'Asha', role: 'user' };

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
});
afterAll(() => ctx.close());

describe('sessions', () => {
  it('creates a session and reads the user back', async () => {
    const token = await createSession(ctx.deps.redis, user);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(await getSession(ctx.deps.redis, token)).toEqual(user);
  });

  it('stores only a SHA-256 of the token, with the TTL', async () => {
    const token = await createSession(ctx.deps.redis, user, 60);
    const key = `sl:sess:${createHash('sha256').update(token).digest('hex')}`;
    expect(await ctx.deps.redis.exists(`sl:sess:${token}`)).toBe(0);
    const ttl = await ctx.deps.redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('returns null after the session is destroyed', async () => {
    const token = await createSession(ctx.deps.redis, user);
    await destroySession(ctx.deps.redis, token);
    expect(await getSession(ctx.deps.redis, token)).toBeNull();
  });

  it('returns null for an unknown token', async () => {
    expect(await getSession(ctx.deps.redis, 'not-a-real-token')).toBeNull();
  });
});
