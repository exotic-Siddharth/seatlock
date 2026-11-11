import { parseArgs } from 'node:util';
import { DEFAULT_QUEUE_OPENS_IN_SEC, DEFAULT_TOKENS_PATH, seedBench, type BenchEventKey } from '../bench/seed';
import type { AppDeps } from '../context';
import { isMain, runScript } from './cli';

const EVENT_KEYS: readonly string[] = ['hot', 'queue'];

const integer = (name: string, value: string, min: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}, got "${value}"`);
  return n;
};

function parseEvents(list: string): BenchEventKey[] {
  const keys = list.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = keys.filter((k) => !EVENT_KEYS.includes(k));
  if (unknown.length > 0) throw new Error(`--events: unknown ${unknown.join(', ')} (expected ${EVENT_KEYS.join(', ')})`);
  return keys as BenchEventKey[];
}

/**
 * `npm run bench:seed -w @seatlock/api -- --users 5000` (spec §11).
 *   --users N              bench users to create or reuse, each with a session (default 5000; 0 keeps users and the tokens file)
 *   --events hot,queue     bench events to create or put back to a fresh state (default both; empty string for none)
 *   --out FILE             tokens file for k6 (default loadtest/.tokens.json, or $BENCH_TOKENS_PATH)
 *   --queue-opens-in SEC   the bench-queue sale opens this long after seeding (default 20)
 */
export async function main(deps: AppDeps, args: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args,
    options: {
      users: { type: 'string', default: '5000' },
      events: { type: 'string', default: 'hot,queue' },
      out: { type: 'string', default: process.env.BENCH_TOKENS_PATH ?? DEFAULT_TOKENS_PATH },
      'queue-opens-in': { type: 'string', default: String(DEFAULT_QUEUE_OPENS_IN_SEC) },
    },
  });
  return seedBench(deps, {
    users: integer('users', values.users, 0),
    events: parseEvents(values.events),
    tokensPath: values.out,
    queueOpensInSec: integer('queue-opens-in', values['queue-opens-in'], 0),
  });
}

if (isMain(import.meta.url)) await runScript('bench:seed', main);
