import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/middleware';
import { TEST_PASSWORD, createUser, makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;
let origin: string;

beforeAll(async () => {
  ctx = await makeCtx();
  origin = ctx.deps.config.webOrigin;
});
beforeEach(() => resetState(ctx));
afterAll(() => ctx.close());

const credentials = { email: 'asha@example.com', name: 'Asha', password: 'correct-horse-battery' };

/** The session Set-Cookie line, and its `name=value` pair for sending back. */
function sessionCookie(res: request.Response): { pair: string; raw: string } {
  const lines = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const raw = lines.find((l) => l.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) throw new Error('no session cookie in response');
  return { pair: raw.split(';')[0]!, raw };
}

describe('POST /api/auth/register', () => {
  it('creates the user and sets an httpOnly session cookie', async () => {
    const res = await request(ctx.app).post('/api/auth/register').send(credentials);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: credentials.email, name: 'Asha', role: 'user' });
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(sessionCookie(res).raw).toMatch(/HttpOnly/i);
    expect(sessionCookie(res).raw).toMatch(/SameSite=Lax/i);
  });

  it('rejects a duplicate email in any letter case with EMAIL_TAKEN', async () => {
    await request(ctx.app).post('/api/auth/register').send(credentials);
    const res = await request(ctx.app)
      .post('/api/auth/register')
      .send({ ...credentials, email: 'ASHA@Example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects a short password', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/register')
      .send({ ...credentials, password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with the right password', async () => {
    await request(ctx.app).post('/api/auth/register').send(credentials);
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: credentials.email, password: credentials.password });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(credentials.email);
    expect(sessionCookie(res).pair).toContain(`${SESSION_COOKIE}=`);
  });

  it('answers a wrong password and an unknown email the same way', async () => {
    await request(ctx.app).post('/api/auth/register').send(credentials);
    const wrong = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: credentials.email, password: 'not-the-password' });
    const unknown = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'not-the-password' });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('answers 429 on the 21st attempt within a minute', async () => {
    const attempt = () =>
      request(ctx.app).post('/api/auth/login').send({ email: 'nobody@example.com', password: TEST_PASSWORD });
    for (let i = 0; i < 20; i++) expect((await attempt()).status).toBe(401);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('session lifecycle', () => {
  it('me returns the user for the cookie, and 401 after logout', async () => {
    const reg = await request(ctx.app).post('/api/auth/register').send(credentials);
    const { pair } = sessionCookie(reg);

    const me = await request(ctx.app).get('/api/auth/me').set('Cookie', pair);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(credentials.email);

    const out = await request(ctx.app).post('/api/auth/logout').set('Cookie', pair).set('Origin', origin);
    expect(out.status).toBe(204);

    const after = await request(ctx.app).get('/api/auth/me').set('Cookie', pair);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('logout also ends a bearer session', async () => {
    const { bearer } = await createUser(ctx);
    expect((await request(ctx.app).post('/api/auth/logout').set(bearer)).status).toBe(204);
    expect((await request(ctx.app).get('/api/auth/me').set(bearer)).status).toBe(401);
  });

  it('logout without a session is still 204', async () => {
    expect((await request(ctx.app).post('/api/auth/logout')).status).toBe(204);
  });

  it('me is 401 for a guest', async () => {
    expect((await request(ctx.app).get('/api/auth/me')).status).toBe(401);
  });
});

describe('POST /api/auth/demo', () => {
  it('signs in the demo user, creating it only once', async () => {
    const first = await request(ctx.app).post('/api/auth/demo');
    const second = await request(ctx.app).post('/api/auth/demo');
    for (const res of [first, second]) {
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email: 'demo@seatlock.dev', name: 'Demo Fan', role: 'user' });
    }
    expect(second.body.user.id).toBe(first.body.user.id);
    const { rows } = await ctx.deps.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users WHERE email = 'demo@seatlock.dev'",
    );
    expect(rows[0]!.n).toBe(1);

    const me = await request(ctx.app).get('/api/auth/me').set('Cookie', sessionCookie(second).pair);
    expect(me.body.user.email).toBe('demo@seatlock.dev');
  });

  it('survives concurrent first-time demo logins', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => request(ctx.app).post('/api/auth/demo')));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.user.id)).size).toBe(1);
  });
});
