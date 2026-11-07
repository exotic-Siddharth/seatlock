import type { BenchRun, BenchSummary, Invariants, StrategyName, Venue } from '@seatlock/shared';

const clean: Invariants = {
  oversoldSeats: 0,
  soldSeatsWithoutTicket: 0,
  ticketsOnUnsoldSeats: 0,
  paidOrdersWithoutTickets: 0,
  ticketsWithoutPaidOrder: 0,
  paidAmountMismatch: 0,
  doublePromisedSeats: 0,
  refundedOrders: 0,
  pass: true,
};

const STRATEGIES: StrategyName[] = ['naive', 'pessimistic', 'conditional', 'redis'];

function run(scenario: BenchRun['scenario'], strategy: StrategyName, i: number): BenchRun {
  const naive = strategy === 'naive';
  return {
    scenario,
    strategy,
    vus: 1000,
    durationSec: 10 + i,
    holds: { attempts: 1000, success: naive ? 7 : 1, conflict: naive ? 990 : 999, errors: 0 },
    holdLatencyMs: { p50: 10 + i, p95: 40 + i * 10, p99: 90 + i, max: 200 + i },
    httpReqsPerSec: 500 + i * 100,
    ticketsSold: 4,
    seatsTotal: 10_000,
    invariants: naive ? { ...clean, oversoldSeats: 3, refundedOrders: 5, pass: false } : clean,
  };
}

/** Two scenarios x four strategies; the naive runs fail their invariants. */
export const summaryFixture: BenchSummary = {
  generatedAt: '2026-11-07T10:00:00.000Z',
  machine: {
    cpu: 'Test CPU 9000',
    logicalCores: 8,
    ramGb: 32,
    dockerCpus: 6,
    dockerMemGb: 12,
    apiReplicas: 2,
    notes: 'Laptop, plugged in.',
  },
  runs: (['hot-seat', 'flash-sale'] as const).flatMap((scenario) => STRATEGIES.map((s, i) => run(scenario, s, i))),
  queue: { vus: 3000, joinP95Ms: 120, pollP95Ms: 45, admitRatePerSec: 200, outOfOrderAdmissions: 0, admittedTotal: 3000 },
};

export const venueFixture: Venue = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'lotus-hall',
  name: 'Lotus Hall',
  city: 'Pune',
  capacity: 480,
  layout: {
    width: 400,
    height: 300,
    stage: { x: 100, y: 10, w: 200, h: 30, label: 'Stage' },
    tiers: [
      { key: 'premium', name: 'Premium' },
      { key: 'standard', name: 'Standard' },
    ],
    sections: [
      { key: 'A', name: 'Stalls', tier: 'premium', rows: 10, seatsPerRow: 20, x: 50, y: 60, angle: 0 },
      { key: 'B', name: 'Balcony', tier: 'standard', rows: 10, seatsPerRow: 28, x: 50, y: 180, angle: 0 },
    ],
  },
};
