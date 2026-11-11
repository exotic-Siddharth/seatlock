import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCtx, type TestCtx } from '../helpers';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await makeCtx();
});
afterAll(() => ctx.close());

describe('health endpoints', () => {
  it('GET /healthz and /api/healthz return 200', async () => {
    for (const path of ['/healthz', '/api/healthz']) {
      const res = await request(ctx.app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    }
  });

  it('GET /readyz returns 200 when Postgres and Redis answer', async () => {
    const res = await request(ctx.app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', postgres: 'ok', redis: 'ok' });
  });

  it('GET /readyz returns 503 when Redis is unreachable', async () => {
    const broken = await makeCtx();
    broken.deps.redis.disconnect();
    const res = await request(broken.app).get('/readyz');
    await broken.close();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'unavailable', postgres: 'ok', redis: 'down' });
  });
});

describe('metrics endpoint', () => {
  it('requires the metrics bearer token', async () => {
    expect((await request(ctx.app).get('/metrics')).status).toBe(401);
    expect((await request(ctx.app).get('/metrics').set('Authorization', 'Bearer wrong')).status).toBe(401);
  });

  it('serves Prometheus text with the seatlock metrics', async () => {
    await request(ctx.app).get('/healthz');
    const res = await request(ctx.app).get('/metrics').set('Authorization', `Bearer ${ctx.deps.config.metricsToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    for (const name of [
      'seatlock_hold_attempts_total',
      'seatlock_hold_duration_seconds',
      'seatlock_orders_total',
      'seatlock_http_request_duration_seconds',
      'seatlock_sse_clients',
      'seatlock_queue_length',
      'process_cpu_seconds_total',
    ]) {
      expect(res.text).toContain(name);
    }
  });

  it('labels request durations with the route pattern, not the raw URL', async () => {
    const fresh = await makeCtx();
    await request(fresh.app).get('/healthz');
    await request(fresh.app).get('/api/holds/0b6f4b5e-5d4a-4bb3-9a4c-6f1f7c2a9e10');
    await request(fresh.app).post('/api/holds').send({});
    await request(fresh.app).get('/api/no-such-route');
    const res = await request(fresh.app).get('/metrics').set('Authorization', `Bearer ${fresh.deps.config.metricsToken}`);
    await fresh.close();

    const counts = res.text.matchAll(/seatlock_http_request_duration_seconds_count\{[^}]*route="([^"]+)"/g);
    const routes = [...new Set([...counts].map((m) => m[1]))].sort();
    expect(routes).toEqual(['/api/holds', '/api/holds/:id', '/healthz', 'unmatched']);
  });
});

describe('error shape', () => {
  it('unknown routes return 404 NOT_FOUND', async () => {
    const res = await request(ctx.app).get('/api/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });

  it('malformed JSON returns 400 VALIDATION_FAILED', async () => {
    const res = await request(ctx.app)
      .post('/api/no-such-route')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
