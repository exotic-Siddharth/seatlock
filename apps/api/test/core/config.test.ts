import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const secret = (c: string) => c.repeat(40);

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 4200,
      webOrigin: 'http://localhost:5175',
      mockpayWebhookUrl: 'http://localhost:4200/api/webhooks/mockpay',
      mockpayLatencyMs: { min: 300, max: 900 },
      holdStrategy: 'conditional',
      benchMode: false,
      pgPoolMax: 20,
      pgConnectTimeoutMs: 10_000,
      logLevel: 'info',
      cookieSecure: false,
      trustProxy: false,
    });
  });

  it('generates missing secrets outside production and says which', () => {
    const config = loadConfig({});
    expect(config.queueTokenSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.mockpayWebhookSecret).not.toBe(config.queueTokenSecret);
    expect(config.generatedSecrets).toEqual(['QUEUE_TOKEN_SECRET', 'MOCKPAY_WEBHOOK_SECRET', 'METRICS_TOKEN']);
    expect(loadConfig({ QUEUE_TOKEN_SECRET: secret('q') }).queueTokenSecret).toBe(secret('q'));
  });

  it('parses flags, numbers and the latency range', () => {
    const config = loadConfig({
      PORT: '5000',
      BENCH_MODE: '1',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: '1',
      PG_POOL_MAX: '50',
      PG_CONNECT_TIMEOUT_MS: '30000',
      MOCKPAY_LATENCY_MS: '5-10',
      HOLD_STRATEGY: 'naive',
    });
    expect(config).toMatchObject({
      port: 5000,
      benchMode: true,
      cookieSecure: true,
      trustProxy: true,
      pgPoolMax: 50,
      pgConnectTimeoutMs: 30_000,
      mockpayLatencyMs: { min: 5, max: 10 },
      holdStrategy: 'naive',
    });
  });

  it('has no session pepper: a SHA-256 of a 256-bit random token needs none, so no knob suggests one', () => {
    const config = loadConfig({ SESSION_SECRET_PEPPER: 'short' });
    expect(Object.keys(config).some((key) => /pepper/i.test(key))).toBe(false);
    // Not validated any more either: production does not refuse a short leftover value.
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        QUEUE_TOKEN_SECRET: 'q'.repeat(32),
        MOCKPAY_WEBHOOK_SECRET: 'm'.repeat(32),
        METRICS_TOKEN: 't'.repeat(32),
        SESSION_SECRET_PEPPER: 'short',
      }),
    ).not.toThrow();
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ MOCKPAY_LATENCY_MS: '900-300' })).toThrow(/MOCKPAY_LATENCY_MS/);
    expect(() => loadConfig({ HOLD_STRATEGY: 'optimistic' })).toThrow(/HOLD_STRATEGY/);
    expect(() => loadConfig({ BENCH_MODE: 'yes please' })).toThrow(/BENCH_MODE/);
  });

  it('allows the naive strategy only in bench mode', () => {
    expect(() => loadConfig({ HOLD_STRATEGY: 'naive' })).toThrow(/naive/);
  });

  it('requires real secrets in production', () => {
    const prod = {
      NODE_ENV: 'production',
      QUEUE_TOKEN_SECRET: secret('q'),
      MOCKPAY_WEBHOOK_SECRET: secret('m'),
      METRICS_TOKEN: secret('t'),
    };
    expect(loadConfig(prod).generatedSecrets).toEqual([]);
    expect(() => loadConfig({ ...prod, MOCKPAY_WEBHOOK_SECRET: undefined })).toThrow(/MOCKPAY_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...prod, QUEUE_TOKEN_SECRET: 'too-short' })).toThrow(/QUEUE_TOKEN_SECRET/);
  });

  it('normalises WEB_ORIGIN to a bare origin', () => {
    expect(loadConfig({ WEB_ORIGIN: 'https://seatlock.example/' }).webOrigin).toBe('https://seatlock.example');
  });
});
