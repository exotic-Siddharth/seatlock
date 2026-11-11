import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a webhook's timestamp may be from our clock before it counts as a replay. */
const TOLERANCE_SEC = 300;

const hmac = (secret: string, rawBody: string | Buffer, t: number) =>
  createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();

/** The `MockPay-Signature` header: `t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`. */
export function signWebhook(secret: string, rawBody: string | Buffer, t: number): string {
  return `t=${t},v1=${hmac(secret, rawBody, t).toString('hex')}`;
}

/**
 * Checks a `MockPay-Signature` header against the exact bytes received. The signature is
 * checked first, so only a genuine (if old) webhook is ever reported as stale.
 */
export function verifyWebhook(
  secret: string,
  header: string,
  rawBody: string | Buffer,
  nowSec: number,
): 'ok' | 'bad_signature' | 'stale' {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return 'bad_signature';
  const t = Number(match[1]);
  const given = Buffer.from(match[2]!, 'hex');

  if (!timingSafeEqual(given, hmac(secret, rawBody, t))) return 'bad_signature';
  return Math.abs(nowSec - t) > TOLERANCE_SEC ? 'stale' : 'ok';
}
