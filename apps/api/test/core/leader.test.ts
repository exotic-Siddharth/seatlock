import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runAsLeader } from '../../src/infra/leader';
import { makeCtx, resetState, type TestCtx } from '../helpers';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await makeCtx();
  await resetState(ctx);
});
afterAll(() => ctx.close());

describe('runAsLeader', () => {
  it('runs the task on exactly one instance and fails over when the leader stops', async () => {
    const name = `probe-${randomUUID()}`;
    const runs = { a: 0, b: 0 };
    const stopA = runAsLeader(ctx.deps, name, 30, async () => void runs.a++);
    await vi.waitFor(() => expect(runs.a).toBeGreaterThan(0));
    const stopB = runAsLeader(ctx.deps, name, 30, async () => void runs.b++);

    await new Promise((r) => setTimeout(r, 200));
    expect(runs.b).toBe(0);
    expect(await ctx.deps.redis.pttl(`sl:leader:${name}`)).toBeGreaterThan(0);

    stopA();
    await vi.waitFor(() => expect(runs.b).toBeGreaterThan(0));
    const runsOfA = runs.a;
    await new Promise((r) => setTimeout(r, 100));
    expect(runs.a).toBe(runsOfA);
    stopB();
  });

  it('keeps running after the task throws', async () => {
    let calls = 0;
    const stop = runAsLeader(ctx.deps, `probe-${randomUUID()}`, 20, async () => {
      calls++;
      throw new Error('task failed');
    });
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
    stop();
  });
});
