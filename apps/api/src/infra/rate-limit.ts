import type { RequestHandler } from 'express';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

export type RateLimitOptions = {
  /** Names the counter, e.g. 'login' or 'holds'. */
  name: string;
  limit: number;
  windowSec: number;
  /** 'user' counts per signed-in user and falls back to the IP for anonymous requests. */
  by: 'user' | 'ip';
};

/**
 * Fixed-window rate limit in Redis (`sl:rl:{name}:{subject}:{window}`). Over the limit it
 * answers 429 RATE_LIMITED with Retry-After. A no-op in bench mode.
 */
export function rateLimit(deps: Pick<AppDeps, 'redis' | 'config'>, opts: RateLimitOptions): RequestHandler {
  if (deps.config.benchMode) return (_req, _res, next) => next();

  return async (req, res, next) => {
    const subject = opts.by === 'user' && req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const window = Math.floor(nowSec / opts.windowSec);
    const key = `sl:rl:${opts.name}:${subject}:${window}`;

    const results = await deps.redis.multi().incr(key).expire(key, opts.windowSec).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    if (count > opts.limit) {
      res.set('Retry-After', String((window + 1) * opts.windowSec - nowSec));
      throw new AppError('RATE_LIMITED', 'Too many requests, please slow down');
    }
    next();
  };
}
