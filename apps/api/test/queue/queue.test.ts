import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearQueue, getQueueEvent, getQueueStatus, joinQueue, simulateCrowd } from '../../src/queue/service';
import { tickQueuesOnce } from '../../src/queue/ticker';
import { verifyQueueToken } from '../../src/queue/token';
import { createOnSaleEvent, createUser, makeCtx, resetState, type TestCtx } from '../helpers';
import { insertUser } from '../events/fixtures';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await makeCtx();
});
beforeEach(() => resetState(ctx));
afterAll(() => ctx.close());

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** A queue-enabled event whose sale opens `opensInMs` from now (negative: already open). */
async function queueEvent(opensInMs: number, admitRatePerSec = 5) {
  const { eventId } = await createOnSaleEvent(ctx, {
    queueEnabled: true,
    admitRatePerSec,
    saleOpensAt: iso(opensInMs),
    startsAt: iso(2 * DAY),
  });
  return eventId;
}

const loadEvent = async (eventId: string) => (await getQueueEvent(ctx.deps.db, eventId))!;

async function users(n: number): Promise<string[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => insertUser(ctx, `Fan ${i}`)));
}

/** Joins the users one after another, so their arrival order is known. */
async function joinAll(eventId: string, ids: string[]) {
  const event = await loadEvent(eventId);
  const statuses = [];
  for (const id of ids) statuses.push(await joinQueue(ctx.deps, event, id));
  return statuses;
}

describe('queue state', () => {
  it('is not_required for an event without a queue', async () => {
    const { eventId } = await createOnSaleEvent(ctx);
    const [userId] = await users(1);
    const status = await getQueueStatus(ctx.deps, await loadEvent(eventId), userId!);
    expect(status).toMatchObject({ state: 'not_required', position: null, token: null });
  });

  it('is not_open more than 10 minutes before the sale, and joining does nothing yet', async () => {
    const eventId = await queueEvent(30 * MIN);
    const [userId] = await users(1);
    const event = await loadEvent(eventId);
    const status = await getQueueStatus(ctx.deps, event, userId!);
    expect(status.state).toBe('not_open');
    expect(Date.parse(status.joinOpensAt)).toBe(event.saleOpensAt.getTime() - 10 * MIN);
    expect((await joinQueue(ctx.deps, event, userId!)).state).toBe('not_open');
    expect((await getQueueStatus(ctx.deps, event, userId!)).queueLength).toBe(0);
  });

  it('is not_joined when the room is open but the user has not joined', async () => {
    const eventId = await queueEvent(5 * MIN);
    const [userId] = await users(1);
    expect((await getQueueStatus(ctx.deps, await loadEvent(eventId), userId!)).state).toBe('not_joined');
  });
});

describe('joining', () => {
  it('gives early arrivals a lottery: positions are a permutation of 1..50', async () => {
    const eventId = await queueEvent(5 * MIN);
    const ids = await users(50);
    await joinAll(eventId, ids);

    const event = await loadEvent(eventId);
    const positions = await Promise.all(ids.map(async (id) => (await getQueueStatus(ctx.deps, event, id)).position));
    expect([...positions].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // A lottery is not arrival order (the chance of 50 random scores arriving sorted is 1 in 50!).
    expect(positions).not.toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('queues later arrivals first-come first-served behind the lottery', async () => {
    const eventId = await queueEvent(5 * MIN);
    const early = await users(10);
    await joinAll(eventId, early);
    await ctx.deps.db.query(`UPDATE events SET sale_opens_at = now() - interval '1 second' WHERE id = $1`, [eventId]);

    const late = await users(3);
    const statuses = await joinAll(eventId, late);
    expect(statuses.map((s) => s.position)).toEqual([11, 12, 13]);
    expect(statuses[0]).toMatchObject({ state: 'waiting', aheadCount: 10, queueLength: 11 });

    const event = await loadEvent(eventId);
    for (const id of early) expect((await getQueueStatus(ctx.deps, event, id)).position).toBeLessThanOrEqual(10);
  });

  it('is idempotent: joining twice keeps the place', async () => {
    const eventId = await queueEvent(-MIN);
    const [a, b] = await users(2);
    await joinAll(eventId, [a!, b!]);
    const event = await loadEvent(eventId);
    expect((await joinQueue(ctx.deps, event, a!)).position).toBe(1);
    expect((await joinQueue(ctx.deps, event, b!)).position).toBe(2);
    expect((await getQueueStatus(ctx.deps, event, b!)).queueLength).toBe(2);
  });

  it('estimates the wait from the admit rate', async () => {
    const eventId = await queueEvent(-MIN, 5);
    const ids = await users(12);
    const statuses = await joinAll(eventId, ids);
    expect(statuses[11]).toMatchObject({ position: 12, aheadCount: 11, estimatedWaitSec: 3, admitRatePerSec: 5 });
  });
});

describe('admission', () => {
  it('tickQueuesOnce admits admitRatePerSec people per tick, in order', async () => {
    const eventId = await queueEvent(-MIN, 5);
    const ids = await users(12);
    await joinAll(eventId, ids);
    const event = await loadEvent(eventId);
    const states = async () => Promise.all(ids.map(async (id) => (await getQueueStatus(ctx.deps, event, id)).state));

    await tickQueuesOnce(ctx.deps);
    expect((await states()).filter((s) => s === 'admitted')).toHaveLength(5);
    expect((await states()).slice(0, 5)).toEqual(Array(5).fill('admitted'));

    await tickQueuesOnce(ctx.deps);
    await tickQueuesOnce(ctx.deps);
    expect((await states()).every((s) => s === 'admitted')).toBe(true); // capped at the queue length
  });

  it('does not admit anyone before the sale opens', async () => {
    const eventId = await queueEvent(5 * MIN, 5);
    const [userId] = await users(1);
    await joinAll(eventId, [userId!]);
    await tickQueuesOnce(ctx.deps);
    expect((await getQueueStatus(ctx.deps, await loadEvent(eventId), userId!)).state).toBe('waiting');
  });

  it('gives an admitted user a valid token whose expiry never moves', async () => {
    const eventId = await queueEvent(-MIN, 5);
    const [userId] = await users(1);
    await joinAll(eventId, [userId!]);
    await tickQueuesOnce(ctx.deps);

    const event = await loadEvent(eventId);
    const first = await getQueueStatus(ctx.deps, event, userId!);
    expect(first.state).toBe('admitted');
    expect(first.token).not.toBeNull();
    expect(
      verifyQueueToken(ctx.deps.config.queueTokenSecret, first.token!, { eventId, userId: userId!, saleOpensAt: event.saleOpensAt.getTime() }),
    ).toBe(true);
    expect(Date.parse(first.tokenExpiresAt!) - Date.now()).toBeGreaterThan(14 * MIN);
    expect(Date.parse(first.tokenExpiresAt!) - Date.now()).toBeLessThanOrEqual(15 * MIN);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await getQueueStatus(ctx.deps, event, userId!);
    expect(second.tokenExpiresAt).toBe(first.tokenExpiresAt);
    expect(second.token).toBe(first.token);
  });

  it('turns expired once the access window has passed, and rejoining goes to the back', async () => {
    const eventId = await queueEvent(-MIN, 5);
    const ids = await users(12);
    await joinAll(eventId, ids);
    await tickQueuesOnce(ctx.deps);
    const event = await loadEvent(eventId);
    const [first, second] = ids as [string, string];
    await getQueueStatus(ctx.deps, event, first); // issues the token

    await ctx.deps.redis.set(`sl:q:${eventId}:tok:${first}`, String(Date.now() - 1));
    const expired = await getQueueStatus(ctx.deps, event, first);
    expect(expired).toMatchObject({ state: 'expired', token: null, tokenExpiresAt: null });

    const rejoined = await joinQueue(ctx.deps, event, first);
    expect(rejoined.state).toBe('waiting');
    expect(rejoined.queueLength).toBe(12);
    expect(rejoined.position).toBe(8); // behind the 7 people not yet admitted; 4 others keep their access
    // Nobody else's access changed: the four still-admitted users keep it, the next in line is first.
    expect((await getQueueStatus(ctx.deps, event, second)).state).toBe('admitted');
    expect((await getQueueStatus(ctx.deps, event, ids[5]!)).position).toBe(1);
  });
});

describe('simulated crowd and clearing', () => {
  it('simulateCrowd grows the queue length by the requested count', async () => {
    const eventId = await queueEvent(-MIN);
    const [userId] = await users(1);
    await joinAll(eventId, [userId!]);
    const event = await loadEvent(eventId);

    const length = await simulateCrowd(ctx.deps, eventId, 100);
    expect(length).toBe(101);
    const status = await getQueueStatus(ctx.deps, event, userId!);
    expect(status.queueLength).toBe(101);
    expect(status.position).toBe(1); // the crowd queued behind the real user
  });

  it('clearQueue forgets everyone, tokens and counters', async () => {
    const eventId = await queueEvent(-MIN, 5);
    const [userId] = await users(1);
    await joinAll(eventId, [userId!]);
    await simulateCrowd(ctx.deps, eventId, 10);
    await tickQueuesOnce(ctx.deps);
    const event = await loadEvent(eventId);
    await getQueueStatus(ctx.deps, event, userId!);

    await clearQueue(ctx.deps, eventId);
    expect(await ctx.deps.redis.keys(`sl:q:${eventId}*`)).toEqual([]);
    expect((await getQueueStatus(ctx.deps, event, userId!)).state).toBe('not_joined');
  });
});

describe('queue routes', () => {
  it('requires a session', async () => {
    const eventId = await queueEvent(-MIN);
    expect((await request(ctx.app).get(`/api/events/${eventId}/queue`)).status).toBe(401);
  });

  it('GET reports the state and POST joins', async () => {
    const eventId = await queueEvent(-MIN);
    const { bearer } = await createUser(ctx);

    const before = await request(ctx.app).get(`/api/events/${eventId}/queue`).set(bearer);
    expect(before.status).toBe(200);
    expect(before.body.queue.state).toBe('not_joined');

    const joined = await request(ctx.app).post(`/api/events/${eventId}/queue`).set(bearer);
    expect(joined.status).toBe(200);
    expect(joined.body.queue).toMatchObject({ state: 'waiting', position: 1, queueLength: 1 });
  });

  it('404s for an unknown event', async () => {
    const { bearer } = await createUser(ctx);
    const res = await request(ctx.app).get('/api/events/00000000-0000-4000-8000-000000000000/queue').set(bearer);
    expect(res.status).toBe(404);
  });
});
