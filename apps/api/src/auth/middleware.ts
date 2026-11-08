import type { Request, RequestHandler, Response } from 'express';
import type { Config } from '../config';
import type { AppDeps } from '../context';
import { AppError } from '../errors';
import { SESSION_TTL_SEC, getSession, type SessionUser } from './sessions';

export const SESSION_COOKIE = 'sl_session';

/**
 * Sets `req.user` and `req.authVia` from `Authorization: Bearer <token>` (used by k6 and
 * scripts) or else the session cookie. An unknown token leaves the request anonymous.
 */
export function loadSession(deps: Pick<AppDeps, 'redis'>): RequestHandler {
  return async (req, _res, next) => {
    const bearer = /^Bearer (\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
    const cookie: unknown = req.cookies?.[SESSION_COOKIE];
    const token = bearer ?? (typeof cookie === 'string' && cookie !== '' ? cookie : undefined);

    req.user = token ? await getSession(deps.redis, token) : null;
    req.authVia = req.user ? (bearer ? 'bearer' : 'cookie') : null;
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  if (req.user.role !== 'admin') throw new AppError('FORBIDDEN', 'Admins only');
  next();
};

/** The signed-in user, for handlers behind `requireAuth`. */
export function currentUser(req: Request): SessionUser {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  return req.user;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for every mutation (any method but GET, HEAD and OPTIONS):
 * - bearer requests are exempt, since a browser never attaches that header on its own;
 * - a cookie-authenticated one must send an Origin equal to WEB_ORIGIN;
 * - an anonymous one is refused if it sends any other Origin ("null" included), so another
 *   site cannot sign a visitor in (login CSRF on /api/auth/demo) or out. Without an Origin it
 *   passes: browsers send one with every cross-site POST, and scripts and curl do not.
 */
export function csrfGuard(config: Pick<Config, 'webOrigin'>): RequestHandler {
  return (req, _res, next) => {
    if (req.authVia !== 'bearer' && !SAFE_METHODS.has(req.method)) {
      const origin = req.get('origin');
      const foreign = origin !== undefined && origin !== config.webOrigin;
      if (foreign || (req.authVia === 'cookie' && origin === undefined)) {
        throw new AppError('CSRF_FAILED', 'Cross-site request blocked');
      }
    }
    next();
  };
}

const cookieOptions = (config: Pick<Config, 'cookieSecure'>) =>
  ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' }) as const;

export function setSessionCookie(res: Response, token: string, config: Pick<Config, 'cookieSecure'>): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(config), maxAge: SESSION_TTL_SEC * 1000 });
}

export function clearSessionCookie(res: Response, config: Pick<Config, 'cookieSecure'>): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(config));
}
