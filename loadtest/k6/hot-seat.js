// Hot seat (spec §11 scenario 1): every VU, a different user, asks for the same 4 seats at the same instant.
// A safe strategy must answer exactly one 201 and VUS-1 409 SEATS_UNAVAILABLE.

import { eventInfo, hold, runMs, requireUsers, sleepUntil, snapshot, summaryTrendStats, userFor, tokens } from './lib.js';

const VUS = Number(__ENV.VUS || 1000);
// VUs are initialised before setup() runs, so this is only slack for the first requests of each VU.
const BARRIER_MS = 3000;

export const options = {
  scenarios: {
    hot_seat: { executor: 'shared-iterations', vus: VUS, iterations: VUS, maxDuration: '2m' },
  },
  summaryTrendStats,
};

export function setup() {
  requireUsers(VUS);
  const token = tokens[0].token;
  const event = eventInfo('bench-hot', token);
  const free = snapshot(event.id, token).seats.filter((s) => s[5] === 'A');
  if (free.length < 4) throw new Error(`bench-hot has ${free.length} free seats: reseed it`);
  // The first four free seats of the first row.
  const seatIds = free.slice(0, 4).map((s) => s[0]);
  return { eventId: event.id, seatIds, startAt: Date.now() + BARRIER_MS };
}

export default function (data) {
  // shared-iterations may hand a second iteration to a VU that finished early; one user, one attempt.
  if (__ITER > 0) return;
  const user = userFor(__VU);
  sleepUntil(data.startAt);
  hold(user.token, data.eventId, data.seatIds);
  runMs.add(Date.now() - data.startAt);
}
