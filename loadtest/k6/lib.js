// Shared helpers for the Seatlock k6 scenarios (spec §11).
//
// Environment (-e on the k6 command line):
//   BASE_URL     nginx, default http://web (the Compose service name)
//   STRATEGY     naive | pessimistic | conditional | redis, sent as X-Bench-Strategy
//   VUS          virtual users of the scenario
//   RUN_ID       makes idempotency keys unique per run
//   TOKENS_FILE  [{userId, token}] written by `npm run bench:seed`, default /loadtest/.tokens.json

import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';

export const BASE_URL = (__ENV.BASE_URL || 'http://web').replace(/\/$/, '');
export const STRATEGY = __ENV.STRATEGY || 'conditional';
export const RUN_ID = __ENV.RUN_ID || 'local';

// A 409 is an expected answer for a hold (somebody else got the seat), not a failed request.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

// Every hold attempt lands in exactly one of these three counters.
export const holdSuccess = new Counter('hold_success');
export const holdConflict = new Counter('hold_conflict');
export const holdError = new Counter('hold_error');
export const holdLatency = new Trend('hold_latency', true);
// When each VU finished, measured from the start barrier. Its max is the length of the run proper,
// without the idle seconds spent waiting for the barrier.
export const runMs = new Trend('run_ms', true);

/** Stats written by --summary-export. p(99) is not in k6's default list. */
export const summaryTrendStats = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];

export const tokens = new SharedArray('tokens', () => {
  const list = JSON.parse(open(__ENV.TOKENS_FILE || '/loadtest/.tokens.json'));
  if (!Array.isArray(list) || list.length === 0) throw new Error('tokens file is empty: run bench:seed first');
  return list;
});

/** Throws, so a misconfigured run stops in setup() instead of producing numbers that look fine. */
export function requireUsers(count) {
  if (tokens.length < count) {
    throw new Error(`${count} VUs need ${count} distinct bench users but the tokens file has ${tokens.length}. Seed more with --users.`);
  }
}

/** Each VU is a different user, so one user's "one active hold per event" rule never interferes with another's. */
export const userFor = (vu) => tokens[(vu - 1) % tokens.length];

export function headers(token, extra) {
  return Object.assign(
    { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Bench-Strategy': STRATEGY },
    extra,
  );
}

export function get(path, token, params) {
  return http.get(`${BASE_URL}${path}`, Object.assign({ headers: headers(token) }, params));
}

export function post(path, token, body, extraHeaders, params) {
  return http.post(
    `${BASE_URL}${path}`,
    body === undefined ? null : JSON.stringify(body),
    Object.assign({ headers: headers(token, extraHeaders) }, params),
  );
}

export function delete_(path, token) {
  return http.del(`${BASE_URL}${path}`, null, { headers: headers(token) });
}

function parse(res) {
  try {
    return res.json();
  } catch {
    return null;
  }
}

/** Sleeps until the wall-clock time `at` (ms). All VUs share one clock, so this is the start barrier. */
export function sleepUntil(at) {
  const ms = at - Date.now();
  if (ms > 0) sleep(ms / 1000);
}

/** The bench event by slug: id, tier keys from most to least expensive, and when its sale opens. */
export function eventInfo(slug, token) {
  const res = get(`/api/events/${slug}`, token);
  const body = parse(res);
  if (res.status !== 200 || !body || !body.event) {
    throw new Error(`GET /api/events/${slug} returned ${res.status}: run bench:seed first (${String(res.body).slice(0, 200)})`);
  }
  const ev = body.event;
  return { id: ev.id, tiers: ev.layout.tiers.map((t) => t.key), saleOpensAt: Date.parse(ev.saleOpensAt) };
}

/** Seat tuples [id, section, row, number, tier, status] and the caller's hold. */
export function snapshot(eventId, token) {
  const res = get(`/api/events/${eventId}/seats`, token);
  const body = parse(res);
  if (res.status !== 200 || !body || !Array.isArray(body.seats)) {
    throw new Error(`GET seats returned ${res.status}: ${String(res.body).slice(0, 200)}`);
  }
  return body;
}

let reported = 0;
/** Prints the first few unexpected responses of this VU, so a broken run is easy to diagnose. */
export function reportUnexpected(what, res) {
  if (reported++ < 3) console.error(`${what}: ${res.status} ${String(res.body).slice(0, 300)}`);
}

/**
 * POST /api/holds and classify the answer:
 *   success   201
 *   conflict  409 SEATS_UNAVAILABLE (details.takenSeatIds says which seats went)
 *   error     anything else, including other 409s such as CHECKOUT_IN_PROGRESS and timeouts
 */
export function hold(token, eventId, seatIds) {
  const res = post('/api/holds', token, { eventId, seatIds });
  holdLatency.add(res.timings.duration);
  const body = parse(res);
  if (res.status === 201 && body && body.hold) {
    holdSuccess.add(1);
    return { outcome: 'success', hold: body.hold, res };
  }
  if (res.status === 409 && body && body.error && body.error.code === 'SEATS_UNAVAILABLE') {
    holdConflict.add(1);
    const taken = body.error.details && Array.isArray(body.error.details.takenSeatIds) ? body.error.details.takenSeatIds : seatIds;
    return { outcome: 'conflict', takenSeatIds: taken, res };
  }
  holdError.add(1);
  reportUnexpected('POST /api/holds', res);
  return { outcome: 'error', res };
}
