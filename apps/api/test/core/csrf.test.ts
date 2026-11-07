import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/middleware';
import { createUser, makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;
let cookie: string;
let bearer: { Authorization: string };

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
  const user = await createUser(ctx);
  cookie = `${SESSION_COOKIE}=${user.token}`;
  bearer = user.bearer;
});
afterAll(() => ctx.close());

// No route lives at this path, so a request that gets past the guard ends in a 404.
const PROBE = '/api/csrf-probe';

describe('csrfGuard', () => {
  it('rejects a cookie-authenticated POST without an Origin', async () => {
    const res = await request(ctx.app).post(PROBE).set('Cookie', cookie).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects a cookie-authenticated POST from another origin', async () => {
    const res = await request(ctx.app).post(PROBE).set('Cookie', cookie).set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
  });

  it('passes a cookie-authenticated POST from WEB_ORIGIN', async () => {
    const res = await request(ctx.app).post(PROBE).set('Cookie', cookie).set('Origin', ctx.deps.config.webOrigin).send({});
    expect(res.status).toBe(404);
  });

  it('passes a bearer-authenticated POST without an Origin', async () => {
    const res = await request(ctx.app).post(PROBE).set(bearer).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('does not guard reads', async () => {
    const res = await request(ctx.app).get(PROBE).set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});
