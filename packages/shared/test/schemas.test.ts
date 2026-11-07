import { describe, expect, it } from 'vitest';
import {
  BenchSummarySchema,
  ConfirmPaymentSchema,
  CreateEventInputSchema,
  ERROR_STATUS,
  HoldRequestSchema,
  RegisterSchema,
} from '../src';

const eventId = '7d4c1a52-3b9e-4f0a-9a51-2f7f3c3e8b10';

describe('HoldRequestSchema', () => {
  it('accepts 1 to 10 distinct seat ids', () => {
    expect(HoldRequestSchema.safeParse({ eventId, seatIds: [1, 2, 3] }).success).toBe(true);
  });

  it('rejects empty, oversized and duplicate seat lists', () => {
    expect(HoldRequestSchema.safeParse({ eventId, seatIds: [] }).success).toBe(false);
    expect(HoldRequestSchema.safeParse({ eventId, seatIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }).success).toBe(false);
    expect(HoldRequestSchema.safeParse({ eventId, seatIds: [5, 5] }).success).toBe(false);
  });

  it('rejects a non-uuid event id', () => {
    expect(HoldRequestSchema.safeParse({ eventId: 'nope', seatIds: [1] }).success).toBe(false);
  });
});

describe('CreateEventInputSchema', () => {
  const base = {
    title: 'Monsoon Static',
    category: 'music',
    venueId: eventId,
    startsAt: '2026-12-01T18:30:00.000Z',
    saleOpensAt: '2026-11-20T10:00:00.000Z',
    tierPrices: { gold: 249900 },
    queueEnabled: false,
  };

  it('accepts a minimal event and leaves optional fields unset', () => {
    const parsed = CreateEventInputSchema.parse(base);
    expect(parsed.admitRatePerSec).toBeUndefined();
  });

  it('requires the sale to open before the event starts', () => {
    const result = CreateEventInputSchema.safeParse({ ...base, saleOpensAt: base.startsAt });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive prices', () => {
    expect(CreateEventInputSchema.safeParse({ ...base, tierPrices: { gold: 0 } }).success).toBe(false);
  });
});

describe('ConfirmPaymentSchema', () => {
  const card = { cardNumber: '4242 4242 4242 4242', expiry: '12/30', cvc: '123', name: 'Asha Rao' };

  it('normalises spaces out of the card number', () => {
    expect(ConfirmPaymentSchema.parse(card).cardNumber).toBe('4242424242424242');
  });

  it('rejects a number that fails the Luhn check', () => {
    expect(ConfirmPaymentSchema.safeParse({ ...card, cardNumber: '4242424242424241' }).success).toBe(false);
  });

  it('rejects a malformed expiry', () => {
    expect(ConfirmPaymentSchema.safeParse({ ...card, expiry: '13/30' }).success).toBe(false);
  });
});

describe('RegisterSchema', () => {
  it('normalises the email and enforces a 10-character password', () => {
    const ok = RegisterSchema.parse({ email: ' Fan@Example.COM ', name: 'Fan', password: 'long-enough-1' });
    expect(ok.email).toBe('fan@example.com');
    expect(RegisterSchema.safeParse({ email: 'a@b.co', name: 'A', password: 'short' }).success).toBe(false);
  });
});

describe('ERROR_STATUS', () => {
  it('maps error codes to HTTP statuses from the spec', () => {
    expect(ERROR_STATUS.VALIDATION_FAILED).toBe(400);
    expect(ERROR_STATUS.SEATS_UNAVAILABLE).toBe(409);
    expect(ERROR_STATUS.HOLD_EXPIRED).toBe(410);
    expect(ERROR_STATUS.TOO_MANY_SEATS).toBe(422);
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
  });
});

describe('BenchSummarySchema', () => {
  it('parses the summary.json shape from the spec', () => {
    const invariants = {
      oversoldSeats: 0, soldSeatsWithoutTicket: 0, ticketsOnUnsoldSeats: 0, paidOrdersWithoutTickets: 0,
      ticketsWithoutPaidOrder: 0, paidAmountMismatch: 0, doublePromisedSeats: 0, refundedOrders: 0, pass: true,
    };
    const summary = {
      generatedAt: '2026-11-08T10:00:00.000Z',
      machine: { cpu: 'i7', logicalCores: 8, ramGb: 32, dockerCpus: 8, dockerMemGb: 16, apiReplicas: 2, notes: '' },
      runs: [{
        scenario: 'hot-seat', strategy: 'conditional', vus: 1000, durationSec: 12.3,
        holds: { attempts: 1000, success: 1, conflict: 999, errors: 0 },
        holdLatencyMs: { p50: 1, p95: 2, p99: 3, max: 4 },
        httpReqsPerSec: 100, ticketsSold: 4, seatsTotal: 10000, invariants,
      }],
      queue: { vus: 3000, joinP95Ms: 5, pollP95Ms: 6, admitRatePerSec: 200, outOfOrderAdmissions: 0, admittedTotal: 3000 },
    };
    expect(BenchSummarySchema.safeParse(summary).success).toBe(true);
  });
});
