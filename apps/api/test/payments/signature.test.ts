import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from '../../src/payments/signature';

const SECRET = 'whsec-test-0123456789-0123456789-abc';
const BODY = '{"id":"evt_1","type":"payment_intent.succeeded","data":{"intentId":"pi_1"}}';
const T = 1_800_000_000;

describe('signWebhook', () => {
  it('signs t + "." + rawBody with HMAC-SHA256, as t=<unix>,v1=<hex>', () => {
    const hex = createHmac('sha256', SECRET).update(`${T}.${BODY}`).digest('hex');
    expect(signWebhook(SECRET, BODY, T)).toBe(`t=${T},v1=${hex}`);
  });
});

describe('verifyWebhook', () => {
  const header = signWebhook(SECRET, BODY, T);

  it('accepts its own signature, for a string or a Buffer body', () => {
    expect(verifyWebhook(SECRET, header, BODY, T)).toBe('ok');
    expect(verifyWebhook(SECRET, header, Buffer.from(BODY), T + 300)).toBe('ok');
    expect(verifyWebhook(SECRET, header, BODY, T - 300)).toBe('ok');
  });

  it('rejects a changed body, another secret or a garbled header', () => {
    expect(verifyWebhook(SECRET, header, BODY.replace('pi_1', 'pi_2'), T)).toBe('bad_signature');
    expect(verifyWebhook('another-secret-another-secret-12345', header, BODY, T)).toBe('bad_signature');
    for (const garbled of ['', 'nonsense', `t=${T}`, `v1=${'0'.repeat(64)}`, `t=${T},v1=abc`, `t=x,v1=${'0'.repeat(64)}`]) {
      expect(verifyWebhook(SECRET, garbled, BODY, T)).toBe('bad_signature');
    }
  });

  it('rejects a timestamp more than 300 s away as stale', () => {
    expect(verifyWebhook(SECRET, header, BODY, T + 301)).toBe('stale');
    expect(verifyWebhook(SECRET, header, BODY, T - 301)).toBe('stale');
  });

  it('checks the signature before the clock, so a forged old request is just a bad signature', () => {
    const forged = signWebhook('not-the-secret-not-the-secret-0000', BODY, T);
    expect(verifyWebhook(SECRET, forged, BODY, T + 1_000)).toBe('bad_signature');
  });
});
