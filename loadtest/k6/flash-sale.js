// Flash sale (spec §11 scenario 2): VUS buyers fight over a 10,000-seat event until it has no free
// seat left or MAX_SECONDS pass.
//
// Each VU, a different user, repeats:
//   1. look at the seat map (a snapshot), keep a sample of 150 free groups of adjacent seats, mostly
//      from the two front tiers so that buyers collide;
//   2. try to hold 1-4 adjacent seats; on a conflict drop the taken seats and pick again after a short
//      jitter, re-reading the map after 4 conflicts in a row or when the sample runs dry;
//   3. with a hold: 90% pay (order + MockPay success card, then poll until paid or failed) and carry on
//      buying, 5% release it and leave, 5% walk away and let it expire.
// It leaves when a fresh snapshot shows no free seat, so the run ends by itself when the event sells out.

import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  RUN_ID, delete_, eventInfo, get, hold, post, reportUnexpected, requireUsers, runMs, sleepUntil, snapshot,
  summaryTrendStats, tokens, userFor,
} from './lib.js';

const VUS = Number(__ENV.VUS || 2000);
const MAX_SECONDS = Number(__ENV.MAX_SECONDS || 120);
const BARRIER_MS = 5000;
const GROUPS = 150; // size of a VU's view of the map: keeps 2,000 VUs from each holding a 10,000-seat array
const PAY_TIMEOUT_MS = 30_000;
const SUCCESS_CARD = { cardNumber: '4242424242424242', expiry: '12/34', cvc: '123', name: 'Bench Buyer' };

const ordersCreated = new Counter('orders_created');
const vuAborted = new Counter('vu_aborted');
const ordersPaid = new Counter('orders_paid');
const ordersFailed = new Counter('orders_failed');
const ordersTimeout = new Counter('orders_timeout');
const ordersError = new Counter('orders_error');
const holdsReleased = new Counter('holds_released');
const holdsAbandoned = new Counter('holds_abandoned');
const orderLatency = new Trend('order_latency', true);

export const options = {
  scenarios: {
    flash_sale: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: `${MAX_SECONDS + 90}s` },
  },
  summaryTrendStats,
};

export function setup() {
  requireUsers(VUS);
  const token = tokens[0].token;
  const event = eventInfo('bench-hot', token);
  const free = snapshot(event.id, token).seats.filter((s) => s[5] === 'A').length;
  if (free === 0) throw new Error('bench-hot has no free seat: reseed it');
  const startAt = Date.now() + BARRIER_MS;
  return { eventId: event.id, tierRank: Object.fromEntries(event.tiers.map((t, i) => [t, i])), startAt, endAt: startAt + MAX_SECONDS * 1000 };
}

/** Groups of up to 4 adjacent free seats, about three quarters of them from the two front tiers. */
function buildView(seats, tierRank) {
  const free = [];
  for (let i = 0; i < seats.length; i++) if (seats[i][5] === 'A') free.push(i);
  const groups = [];
  const seen = new Set();
  for (let tries = 0; groups.length < Math.min(GROUPS, free.length) && tries < GROUPS * 40; tries++) {
    const at = free[Math.floor(Math.random() * free.length)];
    if (seen.has(at)) continue;
    const front = tierRank[seats[at][4]] < 2;
    if (!front && Math.random() > 0.15) continue;
    seen.add(at);
    const group = [seats[at][0]];
    for (let j = at + 1; group.length < 4 && j < seats.length; j++) {
      const s = seats[j];
      if (s[5] !== 'A' || s[1] !== seats[at][1] || s[2] !== seats[at][2]) break;
      group.push(s[0]);
    }
    groups.push(group);
  }
  return { groups, freeCount: free.length };
}

function pay(user, holdId, key) {
  const started = Date.now();
  const created = post('/api/orders', user.token, { holdId }, { 'Idempotency-Key': `${RUN_ID}-${key}-order` });
  const body = created.status === 201 ? created.json() : null;
  if (!body) {
    ordersError.add(1);
    reportUnexpected('POST /api/orders', created);
    return;
  }
  ordersCreated.add(1);
  const confirm = post(
    `/api/mockpay/intents/${body.payment.intentId}/confirm`,
    user.token,
    SUCCESS_CARD,
    { 'Idempotency-Key': `${RUN_ID}-${key}-pay` },
  );
  if (confirm.status !== 202) {
    ordersError.add(1);
    reportUnexpected('POST confirm', confirm);
    return;
  }
  // The webhook arrives 300-900 ms later and takes the order to paid or failed.
  while (Date.now() - started < PAY_TIMEOUT_MS) {
    sleep(0.5);
    const poll = get(`/api/orders/${body.order.id}`, user.token);
    const status = poll.status === 200 ? poll.json().order.status : null;
    if (status === 'paid' || status === 'failed') {
      (status === 'paid' ? ordersPaid : ordersFailed).add(1);
      orderLatency.add(Date.now() - started);
      return;
    }
  }
  ordersTimeout.add(1);
}

export default function (data) {
  sleepUntil(data.startAt);
  try {
    shop(data, userFor(__VU));
  } catch (err) {
    // A failed seat-map read ends this VU; count it so a degraded run cannot look clean.
    vuAborted.add(1);
    console.error(`VU ${__VU} aborted: ${err}`);
  }
  runMs.add(Date.now() - data.startAt);
}

function shop(data, user) {
  let view = { groups: [], freeCount: 0 };
  let conflicts = 0;
  let errors = 0;
  let holdsMade = 0;

  while (Date.now() < data.endAt) {
    if (view.groups.length === 0 || conflicts >= 4) {
      view = buildView(snapshot(data.eventId, user.token).seats, data.tierRank);
      conflicts = 0;
      if (view.freeCount === 0) return; // sold out (or everything left is held by someone else)
    }

    const group = view.groups[Math.floor(Math.random() * view.groups.length)];
    const seatIds = group.slice(0, 1 + Math.floor(Math.random() * group.length));
    const result = hold(user.token, data.eventId, seatIds);

    if (result.outcome === 'conflict') {
      const taken = new Set(result.takenSeatIds);
      view.groups = view.groups.filter((g) => !g.some((id) => taken.has(id)));
      conflicts++;
      sleep(0.02 + Math.random() * 0.1);
    } else if (result.outcome === 'error') {
      if (++errors >= 10) {
        vuAborted.add(1); // the API is not answering: stop instead of hammering it
        return;
      }
      sleep(0.25 + Math.random() * 0.5);
    } else {
      conflicts = 0;
      const mine = new Set(seatIds);
      view.groups = view.groups.filter((g) => !g.some((id) => mine.has(id)));
      const choice = Math.random();
      if (choice < 0.9) {
        pay(user, result.hold.id, `${__VU}-${holdsMade++}`);
      } else if (choice < 0.95) {
        const res = delete_(`/api/holds/${result.hold.id}`, user.token);
        if (res.status !== 204) reportUnexpected('DELETE /api/holds', res);
        holdsReleased.add(1);
        return;
      } else {
        holdsAbandoned.add(1);
        return;
      }
    }
  }
}
