import { randomBytes } from 'node:crypto';
import { LoginSchema, RegisterSchema } from '@seatlock/shared';
import { Router, type Request, type Response } from 'express';
import type { AppDeps } from '../context';
import { pgCode } from '../db';
import { AppError } from '../errors';
import { parse } from '../http';
import { rateLimit } from '../infra/rate-limit';
import { SESSION_COOKIE, clearSessionCookie, setSessionCookie } from './middleware';
import { hashPassword, verifyPassword } from './password';
import { createSession, destroySession, type SessionUser } from './sessions';

const DEMO_EMAIL = 'demo@seatlock.dev';
const DEMO_NAME = 'Demo Fan';

const USER_COLUMNS = `id, email::text AS email, name, role::text AS role`;

/** Opens a session for the user and puts its token in the httpOnly cookie. */
async function signIn(deps: AppDeps, res: Response, user: SessionUser): Promise<void> {
  setSessionCookie(res, await createSession(deps.redis, user), deps.config);
}

/** The token the request authenticated with, from the bearer header or the cookie. */
function sessionToken(req: Request): string | undefined {
  const bearer = /^Bearer (\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
  const cookie: unknown = req.cookies?.[SESSION_COOKIE];
  return bearer ?? (typeof cookie === 'string' && cookie !== '' ? cookie : undefined);
}

export function authRouter(deps: AppDeps): Router {
  const router = Router();
  const authLimit = rateLimit(deps, { name: 'auth', limit: 20, windowSec: 60, by: 'ip' });

  // Verifying against this hash when the email is unknown makes that response take as long as a
  // wrong password does, so login does not reveal which emails are registered.
  let decoyHash: Promise<string> | undefined;

  router.post('/register', authLimit, async (req, res) => {
    const { email, name, password } = parse(RegisterSchema, req.body);
    let user: SessionUser;
    try {
      const { rows } = await deps.db.query<SessionUser>(
        `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
        [email, name, await hashPassword(password)],
      );
      user = rows[0]!;
    } catch (err) {
      if (pgCode(err) === '23505') throw new AppError('EMAIL_TAKEN', 'An account with this email already exists');
      throw err;
    }
    await signIn(deps, res, user);
    res.status(201).json({ user });
  });

  router.post('/login', authLimit, async (req, res) => {
    const { email, password } = parse(LoginSchema, req.body);
    const { rows } = await deps.db.query<SessionUser & { passwordHash: string }>(
      `SELECT ${USER_COLUMNS}, password_hash AS "passwordHash" FROM users WHERE email = $1`,
      [email],
    );
    const found = rows[0];
    decoyHash ??= hashPassword(randomBytes(16).toString('hex'));
    const valid = await verifyPassword(found?.passwordHash ?? (await decoyHash), password);
    if (!found || !valid) throw new AppError('INVALID_CREDENTIALS', 'Wrong email or password');

    const user: SessionUser = { id: found.id, email: found.email, name: found.name, role: found.role };
    await signIn(deps, res, user);
    res.json({ user });
  });

  router.post('/demo', authLimit, async (_req, res) => {
    const select = () => deps.db.query<SessionUser>(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [DEMO_EMAIL]);
    let user = (await select()).rows[0];
    if (!user) {
      // Nobody can sign in as the demo user with a password; only this route opens its session.
      // ON CONFLICT covers two first-time requests racing each other.
      await deps.db.query(
        `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
        [DEMO_EMAIL, DEMO_NAME, await hashPassword(randomBytes(32).toString('hex'))],
      );
      user = (await select()).rows[0]!;
    }
    await signIn(deps, res, user);
    res.json({ user });
  });

  router.post('/logout', async (req, res) => {
    const token = sessionToken(req);
    if (token) await destroySession(deps.redis, token);
    clearSessionCookie(res, deps.config);
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    res.json({ user: req.user });
  });

  return router;
}
