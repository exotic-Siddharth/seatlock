import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSession, sessionKey } from '../../src/auth/sessions';
import { seedBench } from '../../src/bench/seed';
import { makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;
let dir: string;
let tokensPath: string;

beforeAll(async () => {
  ctx = await makeCtx();
  dir = await mkdtemp(path.join(tmpdir(), 'seatlock-bench-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
  tokensPath = path.join(dir, `${Math.random().toString(36).slice(2)}.json`);
});

const readTokens = async (file = tokensPath) =>
  JSON.parse(await readFile(file, 'utf8')) as { userId: string; token: string }[];

const one = async <T extends object>(text: string, params: unknown[] = []) =>
  (await ctx.deps.db.query<T>(text, params)).rows[0]!;

describe('seedBench', () => {
  it('creates bench users and writes a session for each one in the format the API reads', async () => {
    const result = await seedBench(ctx.deps, { users: 25, events: [], tokensPath });
    expect(result.tokensPath).toBe(tokensPath);

    const tokens = await readTokens();
    expect(tokens).toHaveLength(25);
    expect(new Set(tokens.map((t) => t.token)).size).toBe(25);

    const { rows } = await ctx.deps.db.query<{ id: string }>(`SELECT id FROM users WHERE is_bench`);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(tokens.map((t) => t.userId)));

    const first = tokens[0]!;
    const session = await getSession(ctx.deps.redis, first.token);
    expect(session).toMatchObject({ id: first.userId, role: 'user' });
    // Only the hash of the token is stored, under the documented key and with a TTL.
    const key = `sl:sess:${createHash('sha256').update(first.token).digest('hex')}`;
    expect(sessionKey(first.token)).toBe(key);
    expect(await ctx.deps.redis.ttl(key)).toBeGreaterThan(0);
  });

  it('is repeatable: a second run reuses the users and issues fresh sessions', async () => {
    await seedBench(ctx.deps, { users: 10, events: [], tokensPath });
    const before = await readTokens();
    await seedBench(ctx.deps, { users: 10, events: [], tokensPath });
    const after = await readTokens();

    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE is_bench`)).n).toBe(10);
    expect(after.map((t) => t.userId)).toEqual(before.map((t) => t.userId));
    expect(after[0]!.token).not.toBe(before[0]!.token);
  });

  it('leaves users and the tokens file alone when users is 0', async () => {
    await seedBench(ctx.deps, { users: 3, events: [], tokensPath });
    const before = await readFile(tokensPath, 'utf8');
    await seedBench(ctx.deps, { users: 0, events: ['hot'], tokensPath });
    expect(await readFile(tokensPath, 'utf8')).toBe(before);
  });

  it('creates the unlisted 10,000-seat bench-hot event with the sale open and no queue', async () => {
    await seedBench(ctx.deps, { users: 0, events: ['hot'], tokensPath });
    const ev = await one<{
      id: string; listed: boolean; queue_enabled: boolean; hold_ttl_seconds: number; open: boolean; seats: number; priced: number;
    }>(
      `SELECT e.id, e.listed, e.queue_enabled, e.hold_ttl_seconds, e.sale_opens_at < now() AS open,
              (SELECT count(*)::int FROM event_seats WHERE event_id = e.id) AS seats,
              (SELECT count(DISTINCT price_paise)::int FROM event_seats WHERE event_id = e.id) AS priced
       FROM events e WHERE e.slug = 'bench-hot'`,
    );
    expect(ev).toMatchObject({ listed: false, queue_enabled: false, hold_ttl_seconds: 120, open: true, seats: 10_000, priced: 4 });
  });

  it('creates bench-queue with the queue on at 200/s and a sale opening shortly after seeding', async () => {
    await seedBench(ctx.deps, { users: 0, events: ['queue'], tokensPath, queueOpensInSec: 20 });
    const ev = await one<{ listed: boolean; queue_enabled: boolean; admit_rate_per_sec: number; opens_in: number }>(
      `SELECT listed, queue_enabled, admit_rate_per_sec, extract(epoch FROM sale_opens_at - now())::float AS opens_in
       FROM events WHERE slug = 'bench-queue'`,
    );
    expect(ev).toMatchObject({ listed: false, queue_enabled: true, admit_rate_per_sec: 200 });
    expect(ev.opens_in).toBeGreaterThan(15);
    expect(ev.opens_in).toBeLessThanOrEqual(20);
  });

  it('resets an existing bench event: seats, holds, orders, tickets and Redis keys', async () => {
    await seedBench(ctx.deps, { users: 1, events: ['hot'], tokensPath });
    const [{ userId }] = await readTokens();
    const { id: eventId } = await one<{ id: string }>(`SELECT id FROM events WHERE slug = 'bench-hot'`);
    const seats = (await ctx.deps.db.query<{ id: number }>(`SELECT id FROM event_seats WHERE event_id = $1 ORDER BY id LIMIT 2`, [eventId])).rows.map((r) => r.id);

    const hold = await one<{ id: string }>(
      `INSERT INTO holds (event_id, user_id, seat_ids, amount_paise, strategy, status, expires_at)
       VALUES ($1, $2, $3, 100, 'conditional', 'converted', now() + interval '1 minute') RETURNING id`,
      [eventId, userId, seats],
    );
    const order = await one<{ id: string }>(
      `INSERT INTO orders (user_id, event_id, hold_id, status, amount_paise, idempotency_key)
       VALUES ($1, $2, $3, 'paid', 100, 'k1') RETURNING id`,
      [userId, eventId, hold.id],
    );
    await ctx.deps.db.query(`UPDATE event_seats SET status = 'sold', order_id = $2 WHERE id = ANY($1)`, [seats, order.id]);
    await ctx.deps.db.query(
      `INSERT INTO tickets (order_id, event_id, event_seat_id, user_id, code) VALUES ($1, $2, $3, $4, 'SL-RESET-TEST')`,
      [order.id, eventId, seats[0], userId],
    );
    await ctx.deps.redis.set(`sl:seat:${eventId}:${seats[0]}`, 'sold');
    await ctx.deps.redis.set(`sl:q:${eventId}:admitted`, '5');
    await ctx.deps.redis.set('sl:q:unrelated-event:admitted', '9');

    await seedBench(ctx.deps, { users: 0, events: ['hot'], tokensPath });

    const counts = await one<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM holds) AS holds, (SELECT count(*)::int FROM orders) AS orders,
              (SELECT count(*)::int FROM tickets) AS tickets,
              (SELECT count(*)::int FROM event_seats WHERE event_id = $1 AND status <> 'available') AS busy,
              (SELECT count(*)::int FROM event_seats WHERE event_id = $1) AS seats`,
      [eventId],
    );
    expect(counts).toEqual({ holds: 0, orders: 0, tickets: 0, busy: 0, seats: 10_000 });
    expect(await ctx.deps.redis.exists(`sl:seat:${eventId}:${seats[0]}`, `sl:q:${eventId}:admitted`)).toBe(0);
    expect(await ctx.deps.redis.get('sl:q:unrelated-event:admitted')).toBe('9');
  });
});
