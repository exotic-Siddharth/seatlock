import { z } from 'zod';
import { luhnValid } from './cards';

/*
 * Every request body and response shape of the HTTP API (spec §9), plus the
 * benchmark summary (spec §11). Dates are ISO strings and money is integer paise.
 */

const isoDate = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const seatId = z.number().int().positive();
const paise = z.number().int().positive();
const count = z.number().int().nonnegative();

// ---------------------------------------------------------------- enums

export const RoleSchema = z.enum(['user', 'admin']);
export type Role = z.infer<typeof RoleSchema>;

export const StrategyNameSchema = z.enum(['naive', 'pessimistic', 'conditional', 'redis']);
export type StrategyName = z.infer<typeof StrategyNameSchema>;

export const EVENT_CATEGORIES = ['music', 'comedy', 'theatre', 'sports', 'talk'] as const;
export const CategorySchema = z.enum(EVENT_CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const EventStatusSchema = z.enum(['upcoming', 'on_sale', 'sold_out', 'ended']);
export type EventStatus = z.infer<typeof EventStatusSchema>;

/** Effective seat status on the wire: Available, Held, Sold. */
export const SeatCodeSchema = z.enum(['A', 'H', 'S']);
export type SeatCode = z.infer<typeof SeatCodeSchema>;

export const HoldStatusSchema = z.enum(['active', 'converted', 'released', 'expired']);
export type HoldStatus = z.infer<typeof HoldStatusSchema>;

export const OrderStatusSchema = z.enum(['pending_payment', 'paid', 'failed']);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const QueueStateSchema = z.enum(['not_required', 'not_open', 'not_joined', 'waiting', 'admitted', 'expired']);
export type QueueState = z.infer<typeof QueueStateSchema>;

// ---------------------------------------------------------------- users

export const UserSchema = z.object({
  id: uuid,
  email: z.string(),
  name: z.string(),
  role: RoleSchema,
});
export type User = z.infer<typeof UserSchema>;

// ---------------------------------------------------------------- venues (spec §6)

export const VenueTierSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  name: z.string().min(1).max(40),
});
export type VenueTier = z.infer<typeof VenueTierSchema>;

export const VenueSectionSchema = z.object({
  key: z.string().min(1).max(16),
  name: z.string().min(1).max(40),
  tier: z.string().min(1),
  rows: z.number().int().min(1).max(200),
  seatsPerRow: z.number().int().min(1).max(200),
  /** Top-left of row A, seat 1, in viewBox units. */
  x: z.number(),
  y: z.number(),
  /** Degrees, rotation about (x, y). */
  angle: z.number().min(-360).max(360),
  /** Default 'A'; labels continue A..Z, AA.. */
  rowLabelStart: z.string().regex(/^[A-Z]{1,3}$/).optional(),
});
export type VenueSection = z.infer<typeof VenueSectionSchema>;

export const VenueLayoutSchema = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
    stage: z.object({
      x: z.number(),
      y: z.number(),
      w: z.number().positive(),
      h: z.number().positive(),
      label: z.string(),
    }),
    /** Ordered most to least expensive. */
    tiers: z.array(VenueTierSchema).min(1),
    sections: z.array(VenueSectionSchema).min(1),
  })
  .superRefine((layout, ctx) => {
    const tierKeys = new Set(layout.tiers.map((t) => t.key));
    if (tierKeys.size !== layout.tiers.length) {
      ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Tier keys must be unique' });
    }
    const sectionKeys = new Set<string>();
    layout.sections.forEach((section, i) => {
      if (sectionKeys.has(section.key)) {
        ctx.addIssue({ code: 'custom', path: ['sections', i, 'key'], message: `Duplicate section key "${section.key}"` });
      }
      sectionKeys.add(section.key);
      if (!tierKeys.has(section.tier)) {
        ctx.addIssue({ code: 'custom', path: ['sections', i, 'tier'], message: `Unknown tier "${section.tier}"` });
      }
    });
  });
export type VenueLayout = z.infer<typeof VenueLayoutSchema>;

export const VenueSchema = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  city: z.string(),
  capacity: count,
  layout: VenueLayoutSchema,
});
export type Venue = z.infer<typeof VenueSchema>;

// ---------------------------------------------------------------- events

export const EventSummarySchema = z.object({
  id: uuid,
  slug: z.string(),
  title: z.string(),
  subtitle: z.string(),
  category: CategorySchema,
  posterHue: z.number().int(),
  startsAt: isoDate,
  saleOpensAt: isoDate,
  venue: z.object({ name: z.string(), city: z.string() }),
  status: EventStatusSchema,
  priceFromPaise: count,
  counts: z.object({ total: count, available: count }),
  queueEnabled: z.boolean(),
});
export type EventSummary = z.infer<typeof EventSummarySchema>;

export const EventDetailSchema = EventSummarySchema.extend({
  description: z.string(),
  maxSeatsPerOrder: z.number().int(),
  holdTtlSeconds: z.number().int(),
  admitRatePerSec: z.number().int(),
  tierPrices: z.record(z.string(), paise),
  layout: VenueLayoutSchema,
  serverTime: isoDate,
});
export type EventDetail = z.infer<typeof EventDetailSchema>;

/** A row of `GET /api/admin/events` (includes unlisted events). */
export const AdminEventRowSchema = EventSummarySchema.extend({
  listed: z.boolean(),
  soldCount: count,
  revenuePaise: count,
});
export type AdminEventRow = z.infer<typeof AdminEventRowSchema>;

const EventFieldsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  category: CategorySchema,
  venueId: uuid,
  startsAt: isoDate,
  saleOpensAt: isoDate,
  /** Price per layout tier key, in paise. */
  tierPrices: z.record(z.string(), paise),
  queueEnabled: z.boolean(),
  admitRatePerSec: z.number().int().min(1).max(10_000).optional(),
  maxSeatsPerOrder: z.number().int().min(1).max(10).optional(),
  holdTtlSeconds: z.number().int().min(30).max(1800).optional(),
  posterHue: z.number().int().min(0).max(359).optional(),
  listed: z.boolean().optional(),
});

const saleOpensBeforeStart = (e: { saleOpensAt?: string; startsAt?: string }) =>
  !e.saleOpensAt || !e.startsAt || Date.parse(e.saleOpensAt) < Date.parse(e.startsAt);
const saleOpensBeforeStartIssue = { message: 'The sale must open before the event starts', path: ['saleOpensAt'] };

export const CreateEventInputSchema = EventFieldsSchema.refine(saleOpensBeforeStart, saleOpensBeforeStartIssue);
export type CreateEventInput = z.infer<typeof CreateEventInputSchema>;

/** Body of `PATCH /api/admin/events/:id`. */
export const UpdateEventInputSchema = EventFieldsSchema.pick({
  title: true,
  subtitle: true,
  description: true,
  startsAt: true,
  saleOpensAt: true,
  queueEnabled: true,
  admitRatePerSec: true,
  listed: true,
})
  .partial()
  .refine(saleOpensBeforeStart, saleOpensBeforeStartIssue);
export type UpdateEventInput = z.infer<typeof UpdateEventInputSchema>;

/** Values used when a CreateEventInput leaves an optional field out (mirrors the SQL defaults). */
export const EVENT_DEFAULTS = {
  subtitle: '',
  description: '',
  admitRatePerSec: 25,
  maxSeatsPerOrder: 6,
  holdTtlSeconds: 300,
  posterHue: 260,
  listed: true,
} as const;

// ---------------------------------------------------------------- seats

export const SeatTupleSchema = z.tuple([
  seatId, // id
  z.string(), // sectionKey
  z.string(), // rowLabel
  z.number().int(), // seatNumber
  z.string(), // tier
  SeatCodeSchema, // status
]);
export type SeatTuple = z.infer<typeof SeatTupleSchema>;

export const SeatChangeSchema = z.object({ id: seatId, st: SeatCodeSchema });
export type SeatChange = z.infer<typeof SeatChangeSchema>;

export const MyHoldSchema = z.object({
  id: uuid,
  seatIds: z.array(seatId),
  expiresAt: isoDate,
});
export type MyHold = z.infer<typeof MyHoldSchema>;

export const SeatSnapshotSchema = z.object({
  eventId: uuid,
  serverTime: isoDate,
  seats: z.array(SeatTupleSchema),
  myHold: MyHoldSchema.nullable(),
});
export type SeatSnapshot = z.infer<typeof SeatSnapshotSchema>;

// ---------------------------------------------------------------- holds, orders, tickets

export const HoldSeatSchema = z.object({
  id: seatId,
  /** "Sec B · Row C · Seat 12" */
  label: z.string(),
  tier: z.string(),
  pricePaise: paise,
});
export type HoldSeat = z.infer<typeof HoldSeatSchema>;

export const HoldSchema = z.object({
  id: uuid,
  eventId: uuid,
  eventSlug: z.string(),
  eventTitle: z.string(),
  seats: z.array(HoldSeatSchema),
  amountPaise: paise,
  expiresAt: isoDate,
  status: HoldStatusSchema,
  serverTime: isoDate,
  orderId: uuid.nullable(),
});
export type Hold = z.infer<typeof HoldSchema>;

export const TicketSchema = z.object({
  id: uuid,
  code: z.string(),
  seatLabel: z.string(),
  tier: z.string(),
  pricePaise: paise,
  checkedInAt: isoDate.nullable(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const OrderSchema = z.object({
  id: uuid,
  eventId: uuid,
  eventSlug: z.string(),
  eventTitle: z.string(),
  eventStartsAt: isoDate,
  venueName: z.string(),
  status: OrderStatusSchema,
  failureReason: z.string().nullable(),
  lastPaymentError: z.string().nullable(),
  amountPaise: paise,
  createdAt: isoDate,
  paidAt: isoDate.nullable(),
  holdId: uuid,
  holdExpiresAt: isoDate,
  paymentIntentId: z.string(),
  tickets: z.array(TicketSchema),
});
export type Order = z.infer<typeof OrderSchema>;

/** Response of `POST /api/orders`. */
export const CreateOrderResponseSchema = z.object({
  order: OrderSchema,
  payment: z.object({ intentId: z.string(), amountPaise: paise }),
});
export type CreateOrderResponse = z.infer<typeof CreateOrderResponseSchema>;

// ---------------------------------------------------------------- waiting room (spec §8)

export const QueueStatusSchema = z.object({
  state: QueueStateSchema,
  position: z.number().int().nullable(),
  aheadCount: z.number().int().nullable(),
  queueLength: count,
  admitRatePerSec: z.number().int(),
  estimatedWaitSec: z.number().nullable(),
  saleOpensAt: isoDate,
  joinOpensAt: isoDate,
  token: z.string().nullable(),
  tokenExpiresAt: isoDate.nullable(),
  serverTime: isoDate,
});
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

// ---------------------------------------------------------------- stats & admin

/** Response of `GET /api/stats`. */
export const StatsSchema = z.object({
  ticketsSold: count,
  eventsOnSale: count,
  activeHolds: count,
});
export type Stats = z.infer<typeof StatsSchema>;

export const DashboardSchema = z.object({
  event: EventSummarySchema,
  counts: z.object({ available: count, held: count, sold: count, total: count }),
  revenuePaise: count,
  ordersPaid: count,
  ordersFailed: count,
  ordersPending: count,
  activeHolds: count,
  queue: z.object({ length: count, admitted: count, simulated: count }).nullable(),
  /** Holds per second over the last 60 s, oldest first. */
  holdsPerSecond: z.array(count),
  recentOrders: z.array(
    z.object({
      id: uuid,
      userName: z.string(),
      seats: count,
      amountPaise: count,
      status: OrderStatusSchema,
      createdAt: isoDate,
    }),
  ),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

/** Response of `POST /api/admin/checkin`. */
export const CheckinResultSchema = z.object({
  ticket: TicketSchema,
  seatLabel: z.string(),
  eventTitle: z.string(),
  alreadyCheckedIn: z.boolean(),
});
export type CheckinResult = z.infer<typeof CheckinResultSchema>;

// ---------------------------------------------------------------- request bodies

const email = z.string().trim().toLowerCase().email().max(254);

export const RegisterSchema = z.object({
  email,
  name: z.string().trim().min(1).max(80),
  password: z.string().min(10).max(128),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const HoldRequestSchema = z.object({
  eventId: uuid,
  seatIds: z
    .array(seatId)
    .min(1)
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, 'Seat ids must be distinct'),
});
export type HoldRequest = z.infer<typeof HoldRequestSchema>;

export const OrderRequestSchema = z.object({ holdId: uuid });
export type OrderRequest = z.infer<typeof OrderRequestSchema>;

/** Body of the MockPay confirm call. The card number is normalised to bare digits. */
export const ConfirmPaymentSchema = z.object({
  cardNumber: z
    .string()
    .transform((s) => s.replace(/[\s-]/g, ''))
    .refine(luhnValid, 'Card number is not valid'),
  expiry: z.string().trim().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, 'Use MM/YY'),
  cvc: z.string().trim().regex(/^\d{3,4}$/, 'CVC is 3 or 4 digits'),
  name: z.string().trim().min(1).max(80),
});
export type ConfirmPaymentInput = z.infer<typeof ConfirmPaymentSchema>;

export const CheckinSchema = z.object({ code: z.string().trim().toUpperCase().min(1).max(64) });
export type CheckinInput = z.infer<typeof CheckinSchema>;

export const ReopenSaleSchema = z.object({ opensInSec: z.number().int().min(0).max(86_400) });
export type ReopenSaleInput = z.infer<typeof ReopenSaleSchema>;

export const SimulateCrowdSchema = z.object({ count: z.number().int().min(1).max(5000) });
export type SimulateCrowdInput = z.infer<typeof SimulateCrowdSchema>;

// ---------------------------------------------------------------- benchmarks (spec §11)

export const InvariantsSchema = z.object({
  oversoldSeats: count,
  soldSeatsWithoutTicket: count,
  ticketsOnUnsoldSeats: count,
  paidOrdersWithoutTickets: count,
  ticketsWithoutPaidOrder: count,
  paidAmountMismatch: count,
  doublePromisedSeats: count,
  refundedOrders: count,
  pass: z.boolean(),
});
export type Invariants = z.infer<typeof InvariantsSchema>;

export const BenchScenarioSchema = z.enum(['hot-seat', 'flash-sale']);
export type BenchScenario = z.infer<typeof BenchScenarioSchema>;

const ms = z.number().nonnegative();

export const BenchRunSchema = z.object({
  scenario: BenchScenarioSchema,
  strategy: StrategyNameSchema,
  vus: count,
  durationSec: z.number().nonnegative(),
  holds: z.object({ attempts: count, success: count, conflict: count, errors: count }),
  holdLatencyMs: z.object({ p50: ms, p95: ms, p99: ms, max: ms }),
  httpReqsPerSec: z.number().nonnegative(),
  ticketsSold: count,
  seatsTotal: count,
  invariants: InvariantsSchema,
  /** The order and payment path of a flash-sale run (absent in older result files). */
  orders: z.object({ created: count, paid: count, failed: count, errors: count, timeouts: count }).optional(),
  /** Virtual users that gave up before the run finished (absent in older result files). */
  vuAborted: count.optional(),
});
export type BenchRun = z.infer<typeof BenchRunSchema>;

export const BenchMachineSchema = z.object({
  cpu: z.string(),
  logicalCores: count,
  ramGb: z.number().nonnegative(),
  dockerCpus: count,
  dockerMemGb: z.number().nonnegative(),
  apiReplicas: count,
  notes: z.string(),
});
export type BenchMachine = z.infer<typeof BenchMachineSchema>;

export const BenchQueueSchema = z.object({
  vus: count,
  joinP95Ms: ms,
  pollP95Ms: ms,
  admitRatePerSec: count,
  outOfOrderAdmissions: count,
  admittedTotal: count,
});
export type BenchQueue = z.infer<typeof BenchQueueSchema>;

/** `loadtest/results/summary.json` */
export const BenchSummarySchema = z.object({
  generatedAt: isoDate,
  machine: BenchMachineSchema,
  runs: z.array(BenchRunSchema),
  queue: BenchQueueSchema,
});
export type BenchSummary = z.infer<typeof BenchSummarySchema>;
