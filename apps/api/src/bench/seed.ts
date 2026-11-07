import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutCapacity, type CreateEventInput, type VenueLayout } from '@seatlock/shared';
import { newSessionToken, sessionKey, SESSION_TTL_SEC } from '../auth/sessions';
import type { AppDeps } from '../context';
import { createEventWithSeats } from '../events/create';
import { resetBenchEvent } from './reset';

export type BenchEventKey = 'hot' | 'queue';

export type BenchSeedOptions = {
  /** Bench users to create or reuse. 0 leaves users, sessions and the tokens file untouched. */
  users: number;
  events: BenchEventKey[];
  /** Where `[{userId, token}]` is written. Defaults to `loadtest/.tokens.json` in the repo. */
  tokensPath?: string;
  /** How long after seeding the `bench-queue` sale opens. */
  queueOpensInSec?: number;
};

export type BenchSeedResult = {
  tokensPath: string;
  users: number;
  events: { key: BenchEventKey; id: string; slug: string; seats: number }[];
};

export const DEFAULT_TOKENS_PATH = fileURLToPath(new URL('../../../../loadtest/.tokens.json', import.meta.url));
export const DEFAULT_QUEUE_OPENS_IN_SEC = 20;

/**
 * Argon2id hash of a random string that was thrown away. Bench users never log in (their sessions
 * are written straight to Redis), so hashing 5,000 passwords would be wasted work.
 */
const UNUSABLE_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$sQMx3qXnsROhEkh0frXRbA$Amml8dK/PPJsqnamR5gBo5uFxFBCkflhy4SqXmegfcw';

const DAY_MS = 24 * 60 * 60 * 1000;
const VENUE_SLUG = 'bench-stadium';

/** 10,000 seats in four tiers: 1,000 platinum, 2,000 gold, 3,000 silver and 4,000 bronze. */
export const BENCH_LAYOUT: VenueLayout = {
  width: 620,
  height: 2300,
  stage: { x: 160, y: 10, w: 300, h: 30, label: 'Stage' },
  tiers: [
    { key: 'platinum', name: 'Platinum' },
    { key: 'gold', name: 'Gold' },
    { key: 'silver', name: 'Silver' },
    { key: 'bronze', name: 'Bronze' },
  ],
  sections: [
    { key: 'P', name: 'Platinum', tier: 'platinum', rows: 20, seatsPerRow: 50, x: 60, y: 60, angle: 0 },
    { key: 'G', name: 'Gold', tier: 'gold', rows: 40, seatsPerRow: 50, x: 60, y: 290, angle: 0 },
    { key: 'S', name: 'Silver', tier: 'silver', rows: 60, seatsPerRow: 50, x: 60, y: 720, angle: 0 },
    { key: 'B', name: 'Bronze', tier: 'bronze', rows: 80, seatsPerRow: 50, x: 60, y: 1350, angle: 0 },
  ],
};

const TIER_PRICES = { platinum: 499_900, gold: 299_900, silver: 149_900, bronze: 79_900 };

const EVENTS: Record<BenchEventKey, { title: string; slug: string; queueEnabled: boolean; admitRatePerSec: number }> = {
  hot: { title: 'Bench Hot', slug: 'bench-hot', queueEnabled: false, admitRatePerSec: 25 },
  queue: { title: 'Bench Queue', slug: 'bench-queue', queueEnabled: true, admitRatePerSec: 200 },
};

async function ensureVenue(deps: AppDeps): Promise<string> {
  const { rows } = await deps.db.query<{ id: string }>(
    `INSERT INTO venues (slug, name, city, layout, capacity) VALUES ($1, 'Bench Stadium', 'Testville', $2, $3)
     ON CONFLICT (slug) DO UPDATE SET layout = EXCLUDED.layout, capacity = EXCLUDED.capacity
     RETURNING id`,
    [VENUE_SLUG, JSON.stringify(BENCH_LAYOUT), layoutCapacity(BENCH_LAYOUT)],
  );
  return rows[0]!.id;
}

/** Creates bench users up to `count` (existing ones are kept) and returns the first `count` by email. */
async function ensureUsers(deps: AppDeps, count: number): Promise<{ id: string; email: string; name: string }[]> {
  await deps.db.query(
    `INSERT INTO users (email, name, password_hash, is_bench)
     SELECT 'bench-' || lpad(i::text, 5, '0') || '@bench.seatlock.dev', 'Bench User ' || i, $2, true
       FROM generate_series(1, $1::int) AS i
     ON CONFLICT (email) DO NOTHING`,
    [count, UNUSABLE_PASSWORD_HASH],
  );
  const { rows } = await deps.db.query<{ id: string; email: string; name: string }>(
    `SELECT id, email::text AS email, name FROM users
      WHERE is_bench AND email LIKE 'bench-%@bench.seatlock.dev' ORDER BY email LIMIT $1`,
    [count],
  );
  if (rows.length !== count) throw new Error(`Expected ${count} bench users, found ${rows.length}`);
  return rows;
}

/** One pipeline of SET ... EX, in exactly the shape createSession writes (JSON of the SessionUser). */
async function openSessions(deps: AppDeps, users: { id: string; email: string; name: string }[]) {
  const pipeline = deps.redis.pipeline();
  const tokens = users.map((u) => {
    const token = newSessionToken();
    pipeline.set(sessionKey(token), JSON.stringify({ id: u.id, email: u.email, name: u.name, role: 'user' }), 'EX', SESSION_TTL_SEC);
    return { userId: u.id, token };
  });
  const results = (await pipeline.exec()) ?? [];
  const failed = results.find(([err]) => err);
  if (failed) throw failed[0];
  return tokens;
}

async function seedEvent(deps: AppDeps, venueId: string, key: BenchEventKey, queueOpensInSec: number) {
  const spec = EVENTS[key];
  const now = Date.now();
  const startsAt = new Date(now + 30 * DAY_MS);
  // The hot event's sale has been open for a minute; the queue event opens shortly, so clients can join the lottery first.
  const saleOpensAt = new Date(key === 'queue' ? now + queueOpensInSec * 1000 : now - 60_000);

  const existing = await deps.db.query<{ id: string; seats: number }>(
    `SELECT e.id, (SELECT count(*)::int FROM event_seats s WHERE s.event_id = e.id) AS seats
       FROM events e WHERE e.slug = $1`,
    [spec.slug],
  );
  let row: { id: string; seats: number } | undefined = existing.rows[0];
  // A bench event with the wrong number of seats is not comparable between runs: rebuild it.
  if (row && row.seats !== layoutCapacity(BENCH_LAYOUT)) {
    await deps.db.query('DELETE FROM events WHERE id = $1', [row.id]);
    row = undefined;
  }

  if (!row) {
    const input: CreateEventInput = {
      title: spec.title,
      subtitle: 'Load-test event',
      category: 'music',
      venueId,
      startsAt: startsAt.toISOString(),
      saleOpensAt: saleOpensAt.toISOString(),
      tierPrices: TIER_PRICES,
      queueEnabled: spec.queueEnabled,
      admitRatePerSec: spec.admitRatePerSec,
      maxSeatsPerOrder: 6,
      holdTtlSeconds: 120,
      listed: false,
    };
    const created = await createEventWithSeats(deps.db, input);
    if (created.slug !== spec.slug) throw new Error(`Expected slug ${spec.slug}, got ${created.slug}`);
    return { key, id: created.id, slug: created.slug, seats: created.seatCount };
  }

  await resetBenchEvent(deps, row.id);
  await deps.db.query(
    `UPDATE events SET venue_id = $2, starts_at = $3, sale_opens_at = $4, tier_prices = $5, queue_enabled = $6,
                       admit_rate_per_sec = $7, max_seats_per_order = 6, hold_ttl_seconds = 120, listed = false
      WHERE id = $1`,
    [row.id, venueId, startsAt, saleOpensAt, JSON.stringify(TIER_PRICES), spec.queueEnabled, spec.admitRatePerSec],
  );
  return { key, id: row.id, slug: spec.slug, seats: row.seats };
}

/**
 * Prepares the load test: bench users with a Redis session each (written to the tokens file for
 * k6), and the unlisted events `bench-hot` and `bench-queue`, created or put back to a fresh state.
 * Safe to run before every benchmark run.
 */
export async function seedBench(deps: AppDeps, opts: BenchSeedOptions): Promise<BenchSeedResult> {
  const tokensPath = opts.tokensPath ?? DEFAULT_TOKENS_PATH;

  if (opts.users > 0) {
    const tokens = await openSessions(deps, await ensureUsers(deps, opts.users));
    await mkdir(path.dirname(tokensPath), { recursive: true });
    // World-readable on purpose: k6 runs as another user inside its container. The tokens only open
    // sessions of throwaway bench users in the bench stack's Redis.
    await writeFile(tokensPath, JSON.stringify(tokens), { mode: 0o644 });
  }

  const events: BenchSeedResult['events'] = [];
  if (opts.events.length > 0) {
    const venueId = await ensureVenue(deps);
    for (const key of opts.events) {
      events.push(await seedEvent(deps, venueId, key, opts.queueOpensInSec ?? DEFAULT_QUEUE_OPENS_IN_SEC));
    }
  }
  return { tokensPath, users: opts.users, events };
}
