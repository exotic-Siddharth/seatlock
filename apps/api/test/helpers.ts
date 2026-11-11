import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { layoutCapacity, type CreateEventInput, type Role, type VenueLayout } from '@seatlock/shared';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { createSession, type SessionUser } from '../src/auth/sessions';
import { loadConfig, type Config, type LogLevel } from '../src/config';
import { closeDeps, createDeps, type AppDeps } from '../src/context';
import { createEventWithSeats } from '../src/events/create';

/*
 * Integration-test harness. Every test talks to real Postgres and Redis:
 * the database named by TEST_DB_NAME (default seatlock_test) and the Redis
 * DB number TEST_REDIS_DB (default 1), on the servers from DATABASE_URL / REDIS_URL.
 */

export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'seatlock_test';
export const TEST_REDIS_DB = Number(process.env.TEST_REDIS_DB ?? 1);

// resetState truncates every table, so refuse anything that doesn't look like a test database.
if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(TEST_DB_NAME)) {
  throw new Error(`TEST_DB_NAME must be lowercase and contain "test", got "${TEST_DB_NAME}"`);
}
if (!Number.isInteger(TEST_REDIS_DB) || TEST_REDIS_DB < 1 || TEST_REDIS_DB > 15) {
  throw new Error(`TEST_REDIS_DB must be 1..15 (DB 0 is for development), got "${process.env.TEST_REDIS_DB}"`);
}

/** Replaces the path of a connection URL: the database name for Postgres, the DB number for Redis. */
export function withUrlPath(url: string, path: string | number): string {
  const u = new URL(url);
  u.pathname = `/${path}`;
  return u.toString();
}

/** Config pointing at the test database and Redis DB, silent logs unless TEST_LOG_LEVEL is set. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({ ...process.env, NODE_ENV: 'test' });
  return {
    ...base,
    databaseUrl: withUrlPath(base.databaseUrl, TEST_DB_NAME),
    redisUrl: withUrlPath(base.redisUrl, TEST_REDIS_DB),
    logLevel: (process.env.TEST_LOG_LEVEL as LogLevel | undefined) ?? 'silent',
    ...overrides,
  };
}

export type TestCtx = {
  deps: AppDeps;
  app: Express;
  close(): Promise<void>;
};

export async function makeCtx(overrides: Partial<Config> = {}): Promise<TestCtx> {
  const deps = await createDeps(testConfig(overrides));
  return { deps, app: createApp(deps), close: () => closeDeps(deps) };
}

/** Truncates every table except schema_migrations and flushes this worker's Redis DB. */
export async function resetState(ctx: TestCtx): Promise<void> {
  const { rows } = await ctx.deps.db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length > 0) {
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    await ctx.deps.db.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
  await ctx.deps.redis.flushdb();
}

/** Password of every user made by createUser. */
export const TEST_PASSWORD = 'test-password-123';
let testPasswordHash: Promise<string> | undefined;

/** Inserts a user and opens a session for them. Hashes the password once per run, so it's cheap. */
export async function createUser(
  ctx: TestCtx,
  opts: { role?: Role; email?: string; name?: string } = {},
): Promise<{ user: SessionUser; token: string; bearer: { Authorization: string } }> {
  testPasswordHash ??= hashPassword(TEST_PASSWORD);
  const { rows } = await ctx.deps.db.query<SessionUser>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)
     RETURNING id, email::text AS email, name, role::text AS role`,
    [
      opts.email ?? `user-${randomUUID().slice(0, 8)}@test.seatlock.dev`,
      opts.name ?? 'Test User',
      await testPasswordHash,
      opts.role ?? 'user',
    ],
  );
  const user = rows[0]!;
  const token = await createSession(ctx.deps.redis, user);
  return { user, token, bearer: { Authorization: `Bearer ${token}` } };
}

/** 2 sections x 3 rows x 10 seats: section A is gold, section B is silver. */
export const DEFAULT_LAYOUT: VenueLayout = {
  width: 400,
  height: 200,
  stage: { x: 100, y: 10, w: 200, h: 30, label: 'Stage' },
  tiers: [
    { key: 'gold', name: 'Gold' },
    { key: 'silver', name: 'Silver' },
  ],
  sections: [
    { key: 'A', name: 'Sec A', tier: 'gold', rows: 3, seatsPerRow: 10, x: 40, y: 80, angle: 0 },
    { key: 'B', name: 'Sec B', tier: 'silver', rows: 3, seatsPerRow: 10, x: 260, y: 80, angle: 0 },
  ],
};

export async function createVenue(
  ctx: TestCtx,
  layout: VenueLayout = DEFAULT_LAYOUT,
): Promise<{ venueId: string; slug: string; layout: VenueLayout; capacity: number }> {
  const slug = `venue-${randomUUID().slice(0, 8)}`;
  const capacity = layoutCapacity(layout);
  const { rows } = await ctx.deps.db.query<{ id: string }>(
    `INSERT INTO venues (slug, name, city, layout, capacity) VALUES ($1, 'Test Hall', 'Testville', $2, $3) RETURNING id`,
    [slug, JSON.stringify(layout), capacity],
  );
  return { venueId: rows[0]!.id, slug, layout, capacity };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An event whose sale opened a minute ago and which starts in 7 days, on a fresh
 * DEFAULT_LAYOUT venue unless `overrides.venueId` is given. `seatIds` are in id order.
 */
export async function createOnSaleEvent(
  ctx: TestCtx,
  overrides: Partial<CreateEventInput> = {},
): Promise<{ eventId: string; slug: string; seatIds: number[] }> {
  const venueId = overrides.venueId ?? (await createVenue(ctx)).venueId;
  const now = Date.now();
  const { id, slug } = await createEventWithSeats(ctx.deps.db, {
    title: 'Test Event',
    category: 'music',
    startsAt: new Date(now + 7 * DAY_MS).toISOString(),
    saleOpensAt: new Date(now - 60_000).toISOString(),
    tierPrices: { gold: 249900, silver: 99900 },
    queueEnabled: false,
    ...overrides,
    venueId,
  });
  const { rows } = await ctx.deps.db.query<{ id: number }>(
    'SELECT id FROM event_seats WHERE event_id = $1 ORDER BY id',
    [id],
  );
  return { eventId: id, slug, seatIds: rows.map((r) => r.id) };
}
