import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signQueueToken, verifyQueueToken } from '../../src/queue/token';

const secret = 'queue-token-secret-for-tests-0123456789';
const eventId = randomUUID();
const userId = randomUUID();
const exp = Date.now() + 15 * 60_000;
const token = signQueueToken(secret, { e: eventId, u: userId, exp });

describe('queue tokens', () => {
  it('verifies a token for the same event and user', () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyQueueToken(secret, token, { eventId, userId })).toBe(true);
  });

  it('rejects a token for another user or another event', () => {
    expect(verifyQueueToken(secret, token, { eventId, userId: randomUUID() })).toBe(false);
    expect(verifyQueueToken(secret, token, { eventId: randomUUID(), userId })).toBe(false);
  });

  it('rejects a token past exp', () => {
    expect(verifyQueueToken(secret, token, { eventId, userId, now: exp - 1 })).toBe(true);
    expect(verifyQueueToken(secret, token, { eventId, userId, now: exp })).toBe(false);
  });

  it('rejects a token signed with another secret or with a tampered payload', () => {
    const forged = signQueueToken('another-secret-entirely-0123456789abcd', { e: eventId, u: userId, exp });
    expect(verifyQueueToken(secret, forged, { eventId, userId })).toBe(false);

    const [, signature] = token.split('.');
    const payload = Buffer.from(JSON.stringify({ e: eventId, u: userId, exp: exp + 3_600_000 })).toString('base64url');
    expect(verifyQueueToken(secret, `${payload}.${signature}`, { eventId, userId })).toBe(false);
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'abc', 'a.b.c', '.', `${token}x`]) {
      expect(verifyQueueToken(secret, bad, { eventId, userId })).toBe(false);
    }
  });
});
