import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signQueueToken, verifyQueueToken } from '../../src/queue/token';

const secret = 'queue-token-secret-for-tests-0123456789';
const eventId = randomUUID();
const userId = randomUUID();
const exp = Date.now() + 15 * 60_000;
const saleOpensAt = Date.now() - 60_000;
const token = signQueueToken(secret, { e: eventId, u: userId, exp, s: saleOpensAt });
const expected = { eventId, userId, saleOpensAt };

describe('queue tokens', () => {
  it('verifies a token for the same event, user and sale opening', () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyQueueToken(secret, token, expected)).toBe(true);
  });

  it('rejects a token for another user or another event', () => {
    expect(verifyQueueToken(secret, token, { ...expected, userId: randomUUID() })).toBe(false);
    expect(verifyQueueToken(secret, token, { ...expected, eventId: randomUUID() })).toBe(false);
  });

  it('rejects a token past exp', () => {
    expect(verifyQueueToken(secret, token, { ...expected, now: exp - 1 })).toBe(true);
    expect(verifyQueueToken(secret, token, { ...expected, now: exp })).toBe(false);
  });

  it('rejects a token issued before the sale was reopened (another sale_opens_at)', () => {
    expect(verifyQueueToken(secret, token, { ...expected, saleOpensAt: saleOpensAt + 30_000 })).toBe(false);
    const withoutEpoch = signQueueToken(secret, { e: eventId, u: userId, exp } as never);
    expect(verifyQueueToken(secret, withoutEpoch, expected)).toBe(false);
  });

  it('rejects a token signed with another secret or with a tampered payload', () => {
    const forged = signQueueToken('another-secret-entirely-0123456789abcd', { e: eventId, u: userId, exp, s: saleOpensAt });
    expect(verifyQueueToken(secret, forged, expected)).toBe(false);

    const [, signature] = token.split('.');
    const payload = Buffer.from(JSON.stringify({ e: eventId, u: userId, exp: exp + 3_600_000, s: saleOpensAt })).toString('base64url');
    expect(verifyQueueToken(secret, `${payload}.${signature}`, expected)).toBe(false);
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'abc', 'a.b.c', '.', `${token}x`]) {
      expect(verifyQueueToken(secret, bad, expected)).toBe(false);
    }
  });
});
