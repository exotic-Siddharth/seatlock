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
      MOCKPAY_LATENCY_MS: '5-10',
      HOLD_STRATEGY: 'naive',
      SESSION_SECRET_PEPPER: '',
    });
    expect(config).toMatchObject({
      port: 5000,
      benchMode: true,
      cookieSecure: true,
      trustProxy: true,
      pgPoolMax: 50,
      mockpayLatencyMs: { min: 5, max: 10 },
      holdStrategy: 'naive',
      sessionSecretPepper: undefined,
    });
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
