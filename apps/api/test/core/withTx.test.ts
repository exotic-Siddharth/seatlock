import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgCode, withTx } from '../../src/db';
import { makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
});
afterAll(() => ctx.close());

const pgError = (code: string) => Object.assign(new pg.DatabaseError(`simulated ${code}`, 0, 'error'), { code });

describe('withTx', () => {
  it('retries a deadlock (40P01) and returns the result of the attempt that succeeds', async () => {
    let attempts = 0;
    const answer = await withTx(ctx.deps.db, async (c) => {
      attempts++;
      if (attempts <= 2) throw pgError('40P01');
      const { rows } = await c.query<{ answer: number }>('SELECT 42 AS answer');
      return rows[0]!.answer;
    });
    expect(answer).toBe(42);
    expect(attempts).toBe(3);
  });

  it('gives up on a serialization failure (40001) after the configured retries', async () => {
    let attempts = 0;
    const failing = withTx(
      ctx.deps.db,
      async () => {
        attempts++;
        throw pgError('40001');
      },
      { retries: 2 },
    );
    await expect(failing).rejects.toMatchObject({ code: '40001' });
    expect(attempts).toBe(3);
  });

  it('rolls back and does not retry other errors', async () => {
    let attempts = 0;
    const failing = withTx(ctx.deps.db, async (c) => {
      attempts++;
      await c.query(
        `INSERT INTO venues (slug, name, city, layout, capacity) VALUES ('rollback-probe', 'Probe', 'Nowhere', '{}', 0)`,
      );
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    expect(attempts).toBe(1);
    const { rowCount } = await ctx.deps.db.query(`SELECT 1 FROM venues WHERE slug = 'rollback-probe'`);
    expect(rowCount).toBe(0);
  });

  it('commits when fn resolves', async () => {
    await withTx(ctx.deps.db, (c) =>
      c.query(`INSERT INTO venues (slug, name, city, layout, capacity) VALUES ('commit-probe', 'Probe', 'Somewhere', '{}', 0)`),
    );
    const { rowCount } = await ctx.deps.db.query(`SELECT 1 FROM venues WHERE slug = 'commit-probe'`);
    expect(rowCount).toBe(1);
  });
});

describe('pgCode', () => {
  it('reads the SQLSTATE of a real Postgres error', async () => {
    const error = await ctx.deps.db.query('SELECT 1 / 0').catch((e: unknown) => e);
    expect(pgCode(error)).toBe('22012');
  });

  it('returns undefined for anything else', () => {
    expect(pgCode(new Error('plain'))).toBeUndefined();
    expect(pgCode(Object.assign(new Error('socket'), { code: 'EPIPE' }))).toBeUndefined();
    expect(pgCode(null)).toBeUndefined();
  });
});

describe('bigint columns', () => {
  it('come back as numbers, including bigint[]', async () => {
    const { rows } = await ctx.deps.db.query('SELECT 7::bigint AS n, ARRAY[1, 2]::bigint[] AS ids, count(*) AS c FROM (VALUES (1)) v');
    expect(rows[0]).toEqual({ n: 7, ids: [1, 2], c: 1 });
  });
});
