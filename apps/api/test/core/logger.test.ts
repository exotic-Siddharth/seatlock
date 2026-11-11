import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, log: createLogger({ logLevel: 'info' }, stream) };
}

describe('logger redaction', () => {
  it('never writes credentials from request and response headers', () => {
    const { lines, log } = capture();
    log.info({
      req: {
        headers: {
          authorization: 'Bearer secret-session-token',
          cookie: 'sl_session=secret-cookie-token',
          'x-queue-token': 'secret-queue-token',
          'mockpay-signature': 't=1,v1=secret-signature',
        },
      },
      res: { headers: { 'set-cookie': 'sl_session=secret-new-token' } },
    });
    expect(lines.join('')).not.toMatch(/secret/);
    expect(lines.join('')).toContain('[redacted]');
  });

  it('never writes passwords, card details or tokens from logged objects', () => {
    const { lines, log } = capture();
    log.info({ body: { password: 'secret-pw', cardNumber: '4242424242424242', cvc: '123' }, token: 'secret-token' });
    log.info({ password: 'secret-pw', webhookSecret: 'secret-hmac-key' });
    const out = lines.join('');
    expect(out).not.toMatch(/secret|4242|"cvc":"123"/);
  });
});
