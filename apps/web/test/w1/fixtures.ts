import {
  materializeLayout,
  type EventDetail,
  type Hold,
  type Order,
  type QueueStatus,
  type SeatSnapshot,
  type SeatTuple,
  type User,
  type VenueLayout,
} from '@seatlock/shared';

export const FAN: User = { id: '6f1c7a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', email: 'fan@test.dev', name: 'Asha Fan', role: 'user' };
export const EVENT_ID = '0b5e8f9a-1c2d-4e3f-9a8b-7c6d5e4f3a2b';
export const HOLD_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
export const ORDER_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

export const LAYOUT: VenueLayout = {
  width: 400,
  height: 200,
  stage: { x: 100, y: 10, w: 200, h: 30, label: 'Stage' },
  tiers: [
    { key: 'gold', name: 'Gold' },
    { key: 'silver', name: 'Silver' },
  ],
  sections: [
    { key: 'A', name: 'Sec A', tier: 'gold', rows: 2, seatsPerRow: 4, x: 40, y: 80, angle: 0 },
    { key: 'B', name: 'Sec B', tier: 'silver', rows: 2, seatsPerRow: 4, x: 260, y: 80, angle: 0 },
  ],
};
export const TIER_PRICES = { gold: 249900, silver: 99900 };

/** 16 seats, ids 1..16 in layout order: Sec A row A 1-4 (ids 1-4), row B 1-4 (ids 5-8), then Sec B. */
export function makeSeats(status: Record<number, SeatTuple[5]> = {}): SeatTuple[] {
  return materializeLayout(LAYOUT).map((s, i) => [i + 1, s.sectionKey, s.rowLabel, s.seatNumber, s.tier, status[i + 1] ?? 'A']);
}

export const iso = (ms: number) => new Date(ms).toISOString();

export function makeEvent(overrides: Partial<EventDetail> = {}): EventDetail {
  const now = Date.now();
  return {
    id: EVENT_ID,
    slug: 'monsoon-static',
    title: 'Monsoon Static',
    subtitle: 'A night of synth-pop',
    category: 'music',
    posterHue: 210,
    startsAt: iso(now + 7 * 86_400_000),
    saleOpensAt: iso(now - 60_000),
    venue: { name: 'Lotus Hall', city: 'Pune' },
    status: 'on_sale',
    priceFromPaise: 99900,
    counts: { total: 16, available: 16 },
    queueEnabled: false,
    description: 'Original synth-pop under the monsoon sky.',
    maxSeatsPerOrder: 6,
    holdTtlSeconds: 300,
    admitRatePerSec: 25,
    tierPrices: TIER_PRICES,
    layout: LAYOUT,
    serverTime: iso(now),
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<SeatSnapshot> = {}): SeatSnapshot {
  return { eventId: EVENT_ID, serverTime: iso(Date.now()), seats: makeSeats(), myHold: null, ...overrides };
}

export function makeHold(overrides: Partial<Hold> = {}): Hold {
  const now = Date.now();
  return {
    id: HOLD_ID,
    eventId: EVENT_ID,
    eventSlug: 'monsoon-static',
    eventTitle: 'Monsoon Static',
    seats: [
      { id: 1, label: 'Sec A · Row A · Seat 1', tier: 'gold', pricePaise: 249900 },
      { id: 2, label: 'Sec A · Row A · Seat 2', tier: 'gold', pricePaise: 249900 },
    ],
    amountPaise: 499800,
    expiresAt: iso(now + 300_000),
    status: 'active',
    serverTime: iso(now),
    orderId: null,
    ...overrides,
  };
}

export function makeOrder(overrides: Partial<Order> = {}): Order {
  const now = Date.now();
  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    eventSlug: 'monsoon-static',
    eventTitle: 'Monsoon Static',
    eventStartsAt: iso(now + 7 * 86_400_000),
    venueName: 'Lotus Hall',
    status: 'pending_payment',
    failureReason: null,
    lastPaymentError: null,
    amountPaise: 499800,
    createdAt: iso(now),
    paidAt: null,
    holdId: HOLD_ID,
    holdExpiresAt: iso(now + 300_000),
    paymentIntentId: 'pi_TESTINTENT0000000000000000',
    tickets: [],
    ...overrides,
  };
}

export function makeQueue(overrides: Partial<QueueStatus> = {}): QueueStatus {
  const now = Date.now();
  return {
    state: 'not_joined',
    position: null,
    aheadCount: null,
    queueLength: 0,
    admitRatePerSec: 5,
    estimatedWaitSec: null,
    saleOpensAt: iso(now + 180_000),
    joinOpensAt: iso(now - 420_000),
    token: null,
    tokenExpiresAt: null,
    serverTime: iso(now),
    ...overrides,
  };
}
