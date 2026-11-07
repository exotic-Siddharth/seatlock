import pg from 'pg';
import type { Config } from './config';
import type { Logger } from './logger';

type TypeId = Parameters<typeof pg.types.setTypeParser>[0];

// bigint columns (seat ids, count(*)) stay far below 2^53, so read them as numbers, not strings.
const INT8_ARRAY_OID = 1016 as number as TypeId; // bigint[]; pg-types only names scalar OIDs
const parseInt8Array = pg.types.getTypeParser(INT8_ARRAY_OID);
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(INT8_ARRAY_OID, (value: string) =>
  (parseInt8Array(value) as (string | null)[]).map((v) => (v === null ? null : Number(v))),
);

/** Anything that can run a query: the pool or a client checked out of it. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(config: Pick<Config, 'databaseUrl' | 'pgPoolMax' | 'pgConnectTimeoutMs'>, log?: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    connectionTimeoutMillis: config.pgConnectTimeoutMs,
  });
  // An idle client that loses its connection emits here; without a listener it would crash the process.
  pool.on('error', (err) => log?.error({ err }, 'idle Postgres client error'));
  return pool;
}

/** SQLSTATE of a Postgres error, e.g. '23505' (unique_violation); undefined for anything else. */
export function pgCode(e: unknown): string | undefined {
  return e instanceof pg.DatabaseError ? e.code : undefined;
}

const RETRYABLE = new Set(['40P01', '40001']); // deadlock_detected, serialization_failure

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` inside BEGIN/COMMIT on one pooled client and rolls back if it throws.
 * Deadlocks and serialization failures are retried up to `retries` times (default 3)
 * after a 5-25 ms jittered pause, so `fn` must be safe to run again from the start.
 */
export async function withTx<T>(
  db: pg.Pool,
  fn: (c: pg.PoolClient) => Promise<T>,
  opts: { retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      if (attempt >= retries || !RETRYABLE.has(pgCode(e) ?? '')) throw e;
    } finally {
      // A client whose ROLLBACK failed is in an unknown state: destroy it instead of reusing it.
      client.release(broken);
    }
    await sleep(5 + Math.random() * 20);
  }
}
