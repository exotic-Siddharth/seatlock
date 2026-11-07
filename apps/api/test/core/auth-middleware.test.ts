import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, clearSessionCookie, loadSession, requireAdmin, requireAuth, setSessionCookie } from '../../src/auth/middleware';
import { errorHandler } from '../../src/errors';
import { createUser, makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;
let app: express.Express;

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
  app = express()
    .use(cookieParser(), loadSession(ctx.deps))
    .get('/whoami', (req, res) => {
      res.json({ user: req.user, authVia: req.authVia });
    })
    .get('/private', requireAuth, (_req, res) => {
      res.json({ ok: true });
    })
    .get('/admin', requireAdmin, (_req, res) => {
      res.json({ ok: true });
    })
    .post('/login', (_req, res) => {
      setSessionCookie(res, 'tok', ctx.deps.config);
      res.end();
    })
    .post('/logout', (_req, res) => {
      clearSessionCookie(res, ctx.deps.config);
      res.end();
    })
    .use(errorHandler);
});
afterAll(() => ctx.close());

describe('loadSession', () => {
  it('reads the user from a bearer token', async () => {
    const { user, bearer } = await createUser(ctx);
    const res = await request(app).get('/whoami').set(bearer);
    expect(res.body).toEqual({ user, authVia: 'bearer' });
  });

  it('reads the user from the session cookie', async () => {
    const { user, token } = await createUser(ctx);
    const res = await request(app).get('/whoami').set('Cookie', `${SESSION_COOKIE}=${token}`);
    expect(res.body).toEqual({ user, authVia: 'cookie' });
  });

  it('treats an unknown token as anonymous', async () => {
    const res = await request(app).get('/whoami').set('Authorization', 'Bearer nope');
    expect(res.body).toEqual({ user: null, authVia: null });
  });
});

describe('requireAuth and requireAdmin', () => {
  it('rejects anonymous requests with 401 UNAUTHENTICATED', async () => {
    for (const path of ['/private', '/admin']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects a non-admin from admin routes with 403 FORBIDDEN', async () => {
    const { bearer } = await createUser(ctx);
    expect((await request(app).get('/private').set(bearer)).status).toBe(200);
    const res = await request(app).get('/admin').set(bearer);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets an admin through', async () => {
    const { bearer } = await createUser(ctx, { role: 'admin' });
    expect((await request(app).get('/admin').set(bearer)).status).toBe(200);
  });
});

describe('session cookie', () => {
  it('is httpOnly, SameSite=Lax, scoped to / and lasts 7 days', async () => {
    const res = await request(app).post('/login');
    const setCookie = res.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=tok;`));
    expect(setCookie).toContain('Max-Age=604800');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
  });

  it('is cleared on logout', async () => {
    const res = await request(app).post('/logout');
    expect(res.headers['set-cookie']?.[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Expires=Thu, 01 Jan 1970`));
  });
});
