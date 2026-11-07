import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { EventSourceParserStream, type EventSourceMessage } from 'eventsource-parser/stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSseHub, type SseHub } from '../../src/realtime/sse-hub';
import { makeCtx, type TestCtx } from '../helpers';

let ctx: TestCtx;
const servers: Server[] = [];

beforeAll(async () => {
  ctx = await makeCtx();
});
afterAll(async () => {
  for (const s of servers) s.close();
  await ctx.close();
});

/** Serves `hub` on a random port and returns the URL of a stream for `eventId`. */
function serve(hub: SseHub, eventId: string): string {
  const app = express().get('/stream', (_req, res) => {
    hub.addClient(eventId, res);
  });
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/stream`;
}

async function connect(url: string) {
  const abort = new AbortController();
  const res = await fetch(url, { signal: abort.signal });
  const comments: string[] = [];
  const reader = res
    .body!.pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment: (c) => comments.push(c.trim()) }))
    .getReader();

  /** Resolves with the next event of `type`, or rejects after `timeoutMs`. */
  async function next(type: string, timeoutMs: number): Promise<EventSourceMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no "${type}" event within ${timeoutMs} ms`)), remaining);
      });
      const { value, done } = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
      if (done) throw new Error('stream ended');
      if (value.event === type) return value;
    }
  }

  /** Resolves once the server ends the stream. */
  async function ended(timeoutMs: number): Promise<void> {
    await expect(next('never-sent', timeoutMs)).rejects.toThrow('stream ended');
  }

  return { res, next, ended, comments, close: () => abort.abort() };
}

/** A hub of the test's own, on its own subscriber connection. */
async function ownHub(opts: Parameters<typeof createSseHub>[3] = {}) {
  const sub = ctx.deps.redis.duplicate();
  const hub = createSseHub(sub, ctx.deps.log, ctx.deps.metrics, opts);
  await hub.start();
  return {
    hub,
    async dispose() {
      await hub.stop();
      sub.disconnect();
    },
  };
}

describe('SSE hub', () => {
  it('delivers a published seat change to a connected client as `event: seats` within 1 s', async () => {
    const eventId = randomUUID();
    const client = await connect(serve(ctx.deps.hub, eventId));
    expect(client.res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    const started = Date.now();
    await ctx.deps.publisher.publish(eventId, [{ id: 7, st: 'H' }]);
    const event = await client.next('seats', 1000);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(JSON.parse(event.data)).toEqual({ changes: [{ id: 7, st: 'H' }] });
    client.close();
  });

  it("only sends an event's changes to that event's clients", async () => {
    const eventId = randomUUID();
    const client = await connect(serve(ctx.deps.hub, eventId));

    await ctx.deps.publisher.publish(randomUUID(), [{ id: 1, st: 'S' }]);
    await ctx.deps.publisher.publish(eventId, [{ id: 2, st: 'A' }]);

    expect(JSON.parse((await client.next('seats', 1000)).data)).toEqual({ changes: [{ id: 2, st: 'A' }] });
    client.close();
  });

  it('counts clients and forgets them when they disconnect', async () => {
    // Clients closed by earlier tests leave once the server sees their sockets close.
    await vi.waitFor(() => expect(ctx.deps.hub.clientCount()).toBe(0));
    const client = await connect(serve(ctx.deps.hub, randomUUID()));
    expect(ctx.deps.hub.clientCount()).toBe(1);
    client.close();
    await vi.waitFor(() => expect(ctx.deps.hub.clientCount()).toBe(0));
  });

  it('sends stats from the provider and heartbeats on their intervals', async () => {
    const { hub, dispose } = await ownHub({ statsMs: 50, heartbeatMs: 50 });
    hub.setStatsProvider(async (id) => ({ eventId: id, available: 42 }));
    const eventId = randomUUID();
    const client = await connect(serve(hub, eventId));

    const stats = await client.next('stats', 1000);
    expect(JSON.parse(stats.data)).toEqual({ eventId, available: 42 });
    await vi.waitFor(() => expect(client.comments).toContain('hb'));

    client.close();
    await dispose();
  });

  it('ends open streams on stop, so a graceful shutdown is not held up', async () => {
    const { hub, dispose } = await ownHub();
    const client = await connect(serve(hub, randomUUID()));
    await hub.stop();
    await client.ended(1000);
    expect(hub.clientCount()).toBe(0);
    await dispose();
  });
});
