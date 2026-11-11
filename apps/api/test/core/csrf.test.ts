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

  it('passes a bearer-authenticated POST even with a foreign Origin', async () => {
    const res = await request(ctx.app).post(PROBE).set(bearer).set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(404);
  });

  it('rejects an anonymous mutation from another origin', async () => {
    for (const method of ['post', 'patch', 'delete'] as const) {
      const res = await request(ctx.app)[method](PROBE).set('Origin', 'https://evil.example').send({});
      expect(res.status, method).toBe(403);
      expect(res.body.error.code).toBe('CSRF_FAILED');
    }
  });

  it('passes an anonymous POST with no Origin (scripts and curl) or from WEB_ORIGIN', async () => {
    const bare = await request(ctx.app).post(PROBE).send({});
    const same = await request(ctx.app).post(PROBE).set('Origin', ctx.deps.config.webOrigin).send({});
    expect([bare.status, same.status]).toEqual([404, 404]);
  });

  it('treats an opaque "null" Origin (sandboxed frames, some redirects) as foreign', async () => {
    const res = await request(ctx.app).post(PROBE).set('Origin', 'null').send({});
    expect(res.status).toBe(403);
  });
});

/*
 * The body-less auth routes are where an anonymous cross-site POST could do something: sign a
 * visitor into the demo account (login CSRF) or sign them out.
 */
describe('cross-site requests to the auth routes', () => {
  it('refuses to sign a visitor into the demo account from another site', async () => {
    const res = await request(ctx.app).post('/api/auth/demo').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses to sign a visitor out from another site', async () => {
    const res = await request(ctx.app).post('/api/auth/logout').set('Cookie', cookie).set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);
  });

  it('refuses a cross-site login or register', async () => {
    for (const path of ['/api/auth/login', '/api/auth/register']) {
      const res = await request(ctx.app).post(path).set('Origin', 'https://evil.example').send({ email: 'a@b.dev', password: 'x' });
      expect(res.status, path).toBe(403);
    }
  });

  it('still signs into the demo account from WEB_ORIGIN', async () => {
    const res = await request(ctx.app).post('/api/auth/demo').set('Origin', ctx.deps.config.webOrigin);
    expect(res.status).toBe(200);
  });
});
