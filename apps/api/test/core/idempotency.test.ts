import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/errors';
import { requireIdempotencyKey, withIdempotency } from '../../src/infra/idempotency';
import { makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
});
afterAll(() => ctx.close());

const scope = () => ({ userId: randomUUID(), route: 'orders', key: `key-${randomUUID()}`, bodyHash: 'hash-1' });

describe('withIdempotency', () => {
  it('replays the stored response for a repeated key and runs fn once', async () => {
    const s = scope();
    let runs = 0;
    const fn = async () => {
      runs++;
      return { status: 201, body: { orderId: 'ord_1' } };
    };

    const first = await withIdempotency(ctx.deps.redis, s, fn);
    const second = await withIdempotency(ctx.deps.redis, s, fn);

    expect(first).toEqual({ status: 201, body: { orderId: 'ord_1' }, replayed: false });
    expect(second).toEqual({ status: 201, body: { orderId: 'ord_1' }, replayed: true });
    expect(runs).toBe(1);
  });

  it('rejects the same key with a different body hash', async () => {
    const s = scope();
    await withIdempotency(ctx.deps.redis, s, async () => ({ status: 201, body: {} }));
    await expect(
      withIdempotency(ctx.deps.redis, { ...s, bodyHash: 'hash-2' }, async () => ({ status: 201, body: {} })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('lets one of two concurrent calls run and rejects the other as in progress', async () => {
    const s = scope();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fn = async () => {
      runs++;
      await gate;
      return { status: 201, body: { ok: true } };
    };

    const calls = [withIdempotency(ctx.deps.redis, s, fn), withIdempotency(ctx.deps.redis, s, fn)];
    // The winner is parked on the gate, so whichever call settles first is the loser.
    await Promise.race(calls.map((c) => c.catch(() => undefined)));
    release();
    const results = await Promise.allSettled(calls);

    expect(runs).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
  });

  it('frees the key when fn throws, so the client can retry', async () => {
    const s = scope();
    await expect(
      withIdempotency(ctx.deps.redis, s, async () => {
        throw new Error('payment provider down');
      }),
    ).rejects.toThrow('payment provider down');
    const retry = await withIdempotency(ctx.deps.redis, s, async () => ({ status: 201, body: { ok: true } }));
    expect(retry.replayed).toBe(false);
  });
});

describe('requireIdempotencyKey', () => {
  const app = express()
    .post('/', (req, res) => {
      res.json({ key: requireIdempotencyKey(req) });
    })
    .use(errorHandler);

  it('returns a well-formed key', async () => {
    const res = await request(app).post('/').set('Idempotency-Key', 'abc_DEF-123');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'abc_DEF-123' });
  });

  it('rejects a missing or malformed key', async () => {
    for (const key of [undefined, 'short', 'has spaces in it', 'x'.repeat(129)]) {
      const req = request(app).post('/');
      const res = await (key === undefined ? req : req.set('Idempotency-Key', key));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
  });
});
