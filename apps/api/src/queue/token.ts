import { createHmac, timingSafeEqual } from 'node:crypto';

/** e: event id, u: user id, exp: expiry in epoch milliseconds. */
export type QueueTokenClaims = { e: string; u: string; exp: number };

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

/** `base64url(JSON{e,u,exp}).base64url(HMAC-SHA256(secret, payload))` (spec §8). */
export function signQueueToken(secret: string, claims: QueueTokenClaims): string {
  const payload = Buffer.from(JSON.stringify({ e: claims.e, u: claims.u, exp: claims.exp })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** True when the signature is valid and the token is for this event and user and not expired. `now` is epoch ms. */
export function verifyQueueToken(
  secret: string,
  token: string,
  expected: { eventId: string; userId: string; now?: number },
): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload = '', signature = ''] = parts;

  const given = Buffer.from(signature);
  const wanted = Buffer.from(sign(secret, payload));
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return false;

  let claims: Partial<QueueTokenClaims>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<QueueTokenClaims>;
  } catch {
    return false;
  }
  return (
    claims.e === expected.eventId &&
    claims.u === expected.userId &&
    typeof claims.exp === 'number' &&
    (expected.now ?? Date.now()) < claims.exp
  );
}
