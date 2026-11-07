// Waiting room (spec §11 scenario 3): VUS users join the queue of `bench-queue` within 5 s, before
// its sale opens, then poll every ~3 s (+-20%) until they are admitted at the event's rate (200/s).
//
// Besides join and poll latency, every VU prints one JSON line (console.log) describing what it saw.
// run-bench.sh sends them to a file with --console-output and summarize.mjs checks admission order:
//   pos0          position read once everybody has joined and before the sale opens. Nobody is admitted
//                 yet, so this is the user's final place in the queue (1 = first in line).
//   lastWaitSent  when the VU sent its last poll that was answered "waiting"
//   admittedAt    when the VU received the first "admitted" answer (and a token)
// A user k is admitted out of order when some user with a worse place was already admitted
// (admittedAt) before k sent a poll that still said "waiting": the admitted count only grows, so
// that cannot happen unless the queue let somebody jump the line.

import { sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { eventInfo, get, post, requireUsers, sleepUntil, summaryTrendStats, tokens, userFor } from './lib.js';

const VUS = Number(__ENV.VUS || 3000);
const JOIN_WINDOW_S = 5;
const SETTLE_S = 3; // after the join window, before reading pos0
const MAX_SECONDS = Number(__ENV.MAX_SECONDS || 180);
const BARRIER_MS = 3000;

const joinMs = new Trend('queue_join_ms', true);
const pollMs = new Trend('queue_poll_ms', true);

export const options = {
  scenarios: {
    queue: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: `${MAX_SECONDS + 120}s` },
  },
  summaryTrendStats,
};

export function setup() {
  requireUsers(VUS);
  const event = eventInfo('bench-queue', tokens[0].token);
  const startAt = Date.now() + BARRIER_MS;
  const settleAt = startAt + (JOIN_WINDOW_S + SETTLE_S) * 1000;
  // pos0 is only the final place if it is read before anybody is admitted.
  if (event.saleOpensAt < settleAt + 2000) {
    const needed = Math.ceil((settleAt + 2000 - Date.now()) / 1000);
    throw new Error(`bench-queue opens in ${Math.round((event.saleOpensAt - Date.now()) / 1000)} s; seed it with --queue-opens-in ${needed + 30} or more`);
  }
  return { eventId: event.id, startAt, settleAt, saleOpensAt: event.saleOpensAt, endAt: event.saleOpensAt + MAX_SECONDS * 1000 };
}

const statusOf = (res) => {
  try {
    return res.json().queue;
  } catch {
    return null;
  }
};

export default function (data) {
  const user = userFor(__VU);
  const record = { vu: __VU, joinState: null, pos0: null, lastWaitSent: null, admittedAt: null };
  const path = `/api/events/${data.eventId}/queue`;

  sleepUntil(data.startAt);
  sleep(Math.random() * JOIN_WINDOW_S);
  const joined = post(path, user.token, undefined);
  joinMs.add(joined.timings.duration);
  record.joinState = (statusOf(joined) || {}).state || `http_${joined.status}`;

  sleepUntil(data.settleAt);
  const settled = statusOf(get(path, user.token));
  if (settled && settled.state === 'waiting' && Date.now() < data.saleOpensAt) record.pos0 = settled.position;

  while (Date.now() < data.endAt) {
    sleep(3 * (0.8 + Math.random() * 0.4));
    const sentAt = Date.now();
    const res = get(path, user.token);
    const receivedAt = Date.now();
    pollMs.add(res.timings.duration);
    const q = statusOf(res);
    if (q && q.state === 'admitted' && q.token) {
      record.admittedAt = receivedAt;
      break;
    }
    if (q && q.state === 'waiting') record.lastWaitSent = sentAt;
  }

  console.log(JSON.stringify(record));
}
