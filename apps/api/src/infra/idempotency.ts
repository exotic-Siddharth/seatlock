import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { AppError } from '../errors';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const IN_PROGRESS_TTL_SEC = 30;
const DONE_TTL_SEC = 86_400;

/** The request's `Idempotency-Key` header, or 400 IDEMPOTENCY_KEY_REQUIRED. */
export function requireIdempotencyKey(req: Request): string {
  const key = req.get('idempotency-key');
  if (!key || !KEY_PATTERN.test(key)) {
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header of 8-128 letters, digits, _ or -');
  }
  return key;
}

/** SHA-256 of a request body, to spot a key reused with a different request. */
export function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export type IdempotencyScope = { userId: string; route: string; key: string; bodyHash: string };

type Stored =
  | { state: 'in_progress'; bodyHash: string }
  | { state: 'done'; bodyHash: string; status: number; body: unknown };

/**
 * Runs `fn` at most once per (user, route, key) and replays its response afterwards.
 * Redis `sl:idem:{userId}:{route}:{key}` holds `in_progress` (30 s) while `fn` runs, then the
 * response (24 h). A concurrent duplicate gets IDEMPOTENCY_IN_PROGRESS; the same key with a
 * different body gets IDEMPOTENCY_MISMATCH. If `fn` throws, the key is freed for a retry.
 */
export async function withIdempotency(
  redis: Redis,
  scope: IdempotencyScope,
  fn: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown; replayed: boolean }> {
  const key = `sl:idem:${scope.userId}:${scope.route}:${scope.key}`;
  const claim: Stored = { state: 'in_progress', bodyHash: scope.bodyHash };

  // SET NX GET claims the key, or returns what is already there, in one atomic step (Redis 7).
  const existing = await redis.set(key, JSON.stringify(claim), 'EX', IN_PROGRESS_TTL_SEC, 'NX', 'GET');
  if (existing !== null) {
    const stored = JSON.parse(existing) as Stored;
    if (stored.bodyHash !== scope.bodyHash) {
      throw new AppError('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request');
    }
    if (stored.state === 'in_progress') {
      throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'The original request is still being processed');
    }
    return { status: stored.status, body: stored.body, replayed: true };
  }

  let result: { status: number; body: unknown };
  try {
    result = await fn();
  } catch (e) {
    await redis.del(key).catch(() => undefined);
    throw e;
  }
  const done: Stored = { state: 'done', bodyHash: scope.bodyHash, status: result.status, body: result.body };
  await redis.set(key, JSON.stringify(done), 'EX', DONE_TTL_SEC);
  return { status: result.status, body: result.body, replayed: false };
}
