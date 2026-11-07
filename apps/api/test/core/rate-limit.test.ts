import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSession } from '../../src/auth/middleware';
import { errorHandler } from '../../src/errors';
import { rateLimit } from '../../src/infra/rate-limit';
import { createUser, makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
});
afterAll(() => ctx.close());

function appWith(limiter: express.RequestHandler) {
  return express()
    .use(loadSession(ctx.deps), limiter)
    .get('/', (_req, res) => {
      res.json({ ok: true });
    })
    .use(errorHandler);
}

describe('rateLimit', () => {
  it('returns 429 RATE_LIMITED with Retry-After once the window is used up', async () => {
    const app = appWith(rateLimit(ctx.deps, { name: 'probe-ip', limit: 2, windowSec: 60, by: 'ip' }));
    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(200);
    const res = await request(app).get('/');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('counts each signed-in user separately', async () => {
    const app = appWith(rateLimit(ctx.deps, { name: 'probe-user', limit: 1, windowSec: 60, by: 'user' }));
    const alice = await createUser(ctx);
    const bob = await createUser(ctx);
    expect((await request(app).get('/').set(alice.bearer)).status).toBe(200);
    expect((await request(app).get('/').set(alice.bearer)).status).toBe(429);
    expect((await request(app).get('/').set(bob.bearer)).status).toBe(200);
  });

  it('is a no-op in bench mode', async () => {
    const bench = { ...ctx.deps, config: { ...ctx.deps.config, benchMode: true } };
    const app = appWith(rateLimit(bench, { name: 'probe-bench', limit: 1, windowSec: 60, by: 'ip' }));
    for (let i = 0; i < 3; i++) expect((await request(app).get('/')).status).toBe(200);
  });
});
