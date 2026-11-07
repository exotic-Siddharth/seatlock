import type { CreateOrderResponse, HoldStatus, Order, StrategyName } from '@seatlock/shared';
import type { AppDeps } from '../context';
import { withTx, type Queryable } from '../db';
import { AppError } from '../errors';
import { createPaymentIntent } from '../payments/mockpay.service';
import { readOrders } from './serialize';
import { extendSeatGates } from './strategies/redis';

type LockedHold = {
  userId: string;
  eventId: string;
  seatIds: number[];
  amountPaise: number;
  strategy: StrategyName;
  status: HoldStatus;
  lapsed: boolean;
};

/**
 * POST /api/orders (spec §7.2). In one transaction: creates the pending order and its payment
 * intent and extends the hold to max(expires_at, now() + 120 s), so a buyer who reaches the
 * card form with seconds left still has time to pay. Callers wrap it in withIdempotency.
 */
export async function createOrder(
  deps: AppDeps,
  req: { userId: string; holdId: string; idempotencyKey: string },
): Promise<CreateOrderResponse> {
  const { orderId, extended } = await withTx(deps.db, async (c) => {
    // Locking the hold serializes every order attempt for it, so there is only ever one order.
    const { rows } = await c.query<LockedHold>(
      `SELECT user_id AS "userId", event_id AS "eventId", seat_ids AS "seatIds", amount_paise AS "amountPaise",
              strategy, status, expires_at <= now() AS lapsed
         FROM holds WHERE id = $1 FOR UPDATE`,
      [req.holdId],
    );
    const hold = rows[0];
    if (!hold || hold.userId !== req.userId) throw new AppError('NOT_FOUND', 'Hold not found');

    // orders.hold_id is UNIQUE: a second order for the same hold is the first one.
    const existing = await c.query<{ id: string }>('SELECT id FROM orders WHERE hold_id = $1', [req.holdId]);
    if (existing.rows[0]) return { orderId: existing.rows[0].id, extended: null };

    if (hold.status === 'expired' || (hold.status === 'active' && hold.lapsed)) {
      throw new AppError('HOLD_EXPIRED', 'Your hold on these seats has expired');
    }
    if (hold.status !== 'active') throw new AppError('HOLD_NOT_ACTIVE', 'This hold is no longer active');

    const inserted = await c.query<{ id: string }>(
      `INSERT INTO orders (user_id, event_id, hold_id, amount_paise, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [req.userId, hold.eventId, req.holdId, hold.amountPaise, req.idempotencyKey],
    );
    const order = inserted.rows[0];
    // Only reachable once Redis has forgotten the key (24 h): the database still remembers it.
    if (!order) throw new AppError('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for another order');
    await createPaymentIntent(c, order.id, hold.amountPaise);

    const { rows: ext } = await c.query<{ expiresAt: Date }>(
      `UPDATE holds SET expires_at = GREATEST(expires_at, now() + interval '120 seconds')
        WHERE id = $1
        RETURNING expires_at AS "expiresAt"`,
      [req.holdId],
    );
    const kept = await c.query(
      `UPDATE event_seats SET held_until = (SELECT expires_at FROM holds WHERE id = $1), updated_at = now()
        WHERE hold_id = $1 AND status = 'held'
        RETURNING id`,
      [req.holdId],
    );
    // The lapse check above used the transaction's start time; a buyer who took over a seat at
    // the expiry boundary may have won it since. Throwing rolls back the order, intent and
    // extension. Naive holds are exempt: their lost seats must reach payment, where the UNIQUE
    // ticket constraint turns the double promise into SEAT_ALREADY_SOLD (spec §7.2).
    if (hold.strategy !== 'naive' && kept.rowCount !== hold.seatIds.length) {
      throw new AppError('HOLD_EXPIRED', 'Your hold on these seats has expired');
    }
    return { orderId: order.id, extended: { ...hold, expiresAt: ext[0]!.expiresAt } };
  });

  if (extended?.strategy === 'redis') {
    const ttlMs = extended.expiresAt.getTime() - Date.now();
    await extendSeatGates(deps.redis, extended.eventId, extended.seatIds, req.holdId, ttlMs).catch((err: unknown) =>
      deps.log.warn({ err }, 'could not extend the seat gates'),
    );
  }

  const order = await getOrder(deps.db, orderId, req.userId);
  return { order, payment: { intentId: order.paymentIntentId, amountPaise: order.amountPaise } };
}

/** GET /api/orders/:id, owner only. */
export async function getOrder(db: Queryable, orderId: string, userId: string): Promise<Order> {
  const [order] = await readOrders(db, userId, orderId);
  if (!order) throw new AppError('NOT_FOUND', 'Order not found');
  return order;
}

/** GET /api/orders: mine, newest first, with tickets. */
export const listOrders = (db: Queryable, userId: string): Promise<Order[]> => readOrders(db, userId);
