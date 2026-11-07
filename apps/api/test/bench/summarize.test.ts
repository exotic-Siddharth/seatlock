import { describe, expect, it } from 'vitest';

// loadtest/summarize.mjs is plain JavaScript outside this package, so load it by URL (and type the bits used here).
type VuRecord = { vu: number; pos0: number | null; lastWaitSent: number | null; admittedAt: number | null };
type K6Export = { metrics: Record<string, Record<string, number>> };
type Summarize = {
  parseVuLines(text: string): VuRecord[];
  checkAdmissionOrder(records: VuRecord[]): { outOfOrderAdmissions: number; admittedTotal: number; problems: string[] };
  buildRun(input: { scenario: string; strategy: string; vus: number; k6: K6Export; verify: Record<string, unknown> }): {
    durationSec: number;
    holds: Record<string, number>;
    holdLatencyMs: Record<string, number>;
    httpReqsPerSec: number;
    ticketsSold: number;
    invariants: { pass: boolean };
  };
  findProblems(summary: unknown): string[];
  findWarnings(summary: unknown): string[];
};
const specifier = new URL('../../../../loadtest/summarize.mjs', import.meta.url).href;
const { parseVuLines, checkAdmissionOrder, buildRun, findProblems, findWarnings } = (await import(/* @vite-ignore */ specifier)) as Summarize;

const user = (pos0: number, lastWaitSent: number | null, admittedAt: number | null): VuRecord => ({
  vu: pos0,
  pos0,
  lastWaitSent,
  admittedAt,
});

describe('checkAdmissionOrder', () => {
  it('finds no overtaking when admission follows the line', () => {
    // Place 1 is admitted first, 2 next, 3 last; everyone only saw "waiting" before the person ahead was admitted.
    const records = [user(1, 1000, 2000), user(2, 2500, 3000), user(3, 3500, 4000)];
    expect(checkAdmissionOrder(records)).toEqual({ outOfOrderAdmissions: 0, admittedTotal: 3, problems: [] });
  });

  it('counts a user who was still waiting after someone behind them was admitted', () => {
    // Place 3 was admitted at 2000, yet place 1 sent a poll at 5000 that still said "waiting".
    const records = [user(1, 5000, 6000), user(2, 1000, 3000), user(3, 1000, 2000)];
    expect(checkAdmissionOrder(records).outOfOrderAdmissions).toBe(1);
  });

  it('does not count a poll sent before the later user was admitted', () => {
    const records = [user(1, 1999, 6000), user(2, 1000, 3000), user(3, 1000, 2000)];
    expect(checkAdmissionOrder(records).outOfOrderAdmissions).toBe(0);
  });

  it('reports users who were never admitted and places that are not 1..N', () => {
    const { problems, admittedTotal } = checkAdmissionOrder([user(1, 1000, 2000), user(3, 1000, null)]);
    expect(admittedTotal).toBe(1);
    expect(problems.join(' ')).toMatch(/never admitted/);
    expect(problems.join(' ')).toMatch(/not exactly 1\.\.N/);
  });

  it('flags users with no place in line', () => {
    const records = [user(1, 1000, 2000), { ...user(2, 1000, 2000), pos0: null }];
    expect(checkAdmissionOrder(records).problems.join(' ')).toMatch(/no place in line/);
  });
});

describe('parseVuLines', () => {
  it('reads k6 console output and bare JSON, and ignores other lines', () => {
    const text = [
      'time="2026-11-07T17:26:20Z" level=info msg="{\\"vu\\":102,\\"pos0\\":138,\\"lastWaitSent\\":5,\\"admittedAt\\":9}"',
      '{"vu":7,"pos0":1,"lastWaitSent":null,"admittedAt":3}',
      'time="2026-11-07T17:26:21Z" level=warning msg="something else"',
      '',
    ].join('\n');
    expect(parseVuLines(text)).toEqual([
      { vu: 102, pos0: 138, lastWaitSent: 5, admittedAt: 9 },
      { vu: 7, pos0: 1, lastWaitSent: null, admittedAt: 3 },
    ]);
  });
});

const k6Export = (over: Record<string, Record<string, number>> = {}): K6Export => ({
  metrics: {
    hold_success: { count: 1, rate: 0.3 },
    hold_conflict: { count: 999, rate: 300 },
    hold_latency: { avg: 80, min: 10, med: 70, max: 400, 'p(90)': 150, 'p(95)': 200, 'p(99)': 350 },
    run_ms: { avg: 200, min: 50, med: 190, max: 500, 'p(90)': 450, 'p(95)': 480, 'p(99)': 499 },
    http_reqs: { count: 1003, rate: 90 },
    ...over,
  },
});
const verification = (over: Record<string, unknown> = {}) => ({
  oversoldSeats: 0, soldSeatsWithoutTicket: 0, ticketsOnUnsoldSeats: 0, paidOrdersWithoutTickets: 0,
  ticketsWithoutPaidOrder: 0, paidAmountMismatch: 0, doublePromisedSeats: 0, refundedOrders: 0, pass: true,
  ticketsSold: 0, seatsTotal: 10_000, ...over,
});

describe('buildRun', () => {
  it('maps the k6 export and the verification onto a BenchRun', () => {
    const run = buildRun({ scenario: 'hot-seat', strategy: 'conditional', vus: 1000, k6: k6Export(), verify: verification() });
    expect(run).toMatchObject({
      durationSec: 0.5,
      holds: { attempts: 1000, success: 1, conflict: 999, errors: 0 },
      holdLatencyMs: { p50: 70, p95: 200, p99: 350, max: 400 },
      httpReqsPerSec: 2006,
      ticketsSold: 0,
      invariants: { pass: true },
    });
  });

  it('counts failed requests, and a missing counter as zero', () => {
    const k6 = k6Export({ hold_error: { count: 4, rate: 1 } });
    delete k6.metrics.hold_conflict;
    expect(buildRun({ scenario: 'hot-seat', strategy: 'redis', vus: 5, k6, verify: verification() }).holds).toEqual({
      attempts: 5, success: 1, conflict: 0, errors: 4,
    });
  });

  it('refuses a k6 export without the hold metrics', () => {
    expect(() => buildRun({ scenario: 'hot-seat', strategy: 'redis', vus: 5, k6: { metrics: {} }, verify: verification() })).toThrow(/hold_latency/);
  });
});

describe('findProblems', () => {
  const run = (scenario: string, strategy: string, over: Record<string, unknown> = {}) => ({
    scenario, strategy, vus: 1000, durationSec: 1,
    holds: { attempts: 1000, success: 1, conflict: 999, errors: 0 },
    holdLatencyMs: { p50: 1, p95: 1, p99: 1, max: 1 }, httpReqsPerSec: 1, ticketsSold: 50, seatsTotal: 10_000,
    invariants: verification(), ...over,
  });
  const complete = (...changed: ReturnType<typeof run>[]) => ({
    runs: ['hot-seat', 'flash-sale'].flatMap((sc) =>
      ['naive', 'pessimistic', 'conditional', 'redis'].map((st) => changed.find((r) => r.scenario === sc && r.strategy === st) ?? run(sc, st)),
    ),
    queue: { outOfOrderAdmissions: 0 },
  });

  it('is quiet for a clean, complete set of results', () => {
    expect(findProblems(complete())).toEqual([]);
  });

  it('fails a safe strategy whose invariants failed, but not naive for double-promised seats alone', () => {
    const bad = verification({ doublePromisedSeats: 3, pass: false });
    expect(findProblems(complete(run('flash-sale', 'redis', { invariants: bad })))).toEqual([
      'flash-sale/redis: invariants FAILED (doublePromisedSeats=3)',
    ]);
    const naive = run('hot-seat', 'naive', { holds: { attempts: 1000, success: 37, conflict: 963, errors: 0 }, invariants: verification({ doublePromisedSeats: 36 }) });
    expect(findProblems(complete(naive))).toEqual([]);
  });

  it('fails a safe hot-seat run that did not have exactly one winner', () => {
    const two = run('hot-seat', 'pessimistic', { holds: { attempts: 1000, success: 2, conflict: 998, errors: 0 } });
    expect(findProblems(complete(two)).join(' ')).toMatch(/2 holds succeeded .* expected exactly 1/);
  });

  it('fails a missing result and any queue overtaking', () => {
    const missing = { ...complete(), runs: complete().runs.slice(1) };
    expect(findProblems(missing)).toEqual(['hot-seat/naive: no result']);
    expect(findProblems({ ...complete(), queue: { outOfOrderAdmissions: 2 } }).join(' ')).toMatch(/2 users were overtaken/);
  });

  it('warns, without failing, about hold requests that errored', () => {
    const noisy = complete(run('flash-sale', 'conditional', { holds: { attempts: 100, success: 90, conflict: 6, errors: 4 } }));
    expect(findProblems(noisy)).toEqual([]);
    expect(findWarnings(noisy)).toEqual([expect.stringMatching(/flash-sale\/conditional: 4 of 100 hold requests failed/)]);
  });
});
