import {
  CheckinSchema,
  CreateEventInputSchema,
  ReopenSaleSchema,
  SimulateCrowdSchema,
  UpdateEventInputSchema,
  seatLabel,
  type CheckinResult,
  type Dashboard,
  type OrderStatus,
  type Venue,
  type VenueLayout,
} from '@seatlock/shared';
import { Router } from 'express';
import { requireAdmin } from '../auth/middleware';
import { releaseHoldsForEvent } from '../booking/holds.service';
import type { AppDeps } from '../context';
import { AppError } from '../errors';
import { createEventWithSeats } from '../events/create';
import { findEventById, listAllEvents, toAdminRow, toSummary, type EventRow } from '../events/queries';
import { parse } from '../http';
import { clearQueue, getQueueCounters, simulateCrowd } from '../queue/service';

const HOLD_RATE_WINDOW_SEC = 60;

export function adminRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAdmin);

  const requireEvent = async (id: string | string[] | undefined): Promise<EventRow> => {
    const row = await findEventById(deps.db, String(id));
    if (!row) throw new AppError('NOT_FOUND', 'Event not found');
    return row;
  };

  router.get('/venues', async (_req, res) => {
    const { rows } = await deps.db.query<Venue>('SELECT id, slug, name, city, capacity, layout FROM venues ORDER BY name');
    res.json({ items: rows });
  });

  router.get('/events', async (_req, res) => {
    res.json({ items: (await listAllEvents(deps.db)).map(toAdminRow) });
  });

  router.post('/events', async (req, res) => {
    const created = await createEventWithSeats(deps.db, parse(CreateEventInputSchema, req.body));
    res.status(201).json({ event: toAdminRow(await requireEvent(created.id)) });
  });

  router.patch('/events/:id', async (req, res) => {
    const current = await requireEvent(req.params.id);
    const patch = parse(UpdateEventInputSchema, req.body);

    // The schema can only compare the two times when both are in the body; compare against the stored ones too.
    const saleOpensAt = patch.saleOpensAt ?? current.sale_opens_at.toISOString();
    const startsAt = patch.startsAt ?? current.starts_at.toISOString();
    if (Date.parse(saleOpensAt) >= Date.parse(startsAt)) {
      throw new AppError('VALIDATION_FAILED', 'The sale must open before the event starts');
    }

    await deps.db.query(
      `UPDATE events SET title = COALESCE($2, title), subtitle = COALESCE($3, subtitle),
              description = COALESCE($4, description), starts_at = COALESCE($5, starts_at),
              sale_opens_at = COALESCE($6, sale_opens_at), queue_enabled = COALESCE($7, queue_enabled),
              admit_rate_per_sec = COALESCE($8, admit_rate_per_sec), listed = COALESCE($9, listed)
       WHERE id = $1`,
      [
        current.id,
        patch.title ?? null,
        patch.subtitle ?? null,
        patch.description ?? null,
        patch.startsAt ?? null,
        patch.saleOpensAt ?? null,
        patch.queueEnabled ?? null,
        patch.admitRatePerSec ?? null,
        patch.listed ?? null,
      ],
    );
    res.json({ event: toAdminRow(await requireEvent(current.id)) });
  });

  router.get('/events/:id/dashboard', async (req, res) => {
    const event = await requireEvent(req.params.id);
    const nowSec = Math.floor(Date.now() / 1000);
    // B1 counts holds in Redis per second: sl:hps:{event}:{unix second}. Oldest first; a missing key is 0.
    const secondKeys = Array.from({ length: HOLD_RATE_WINDOW_SEC }, (_, i) => `sl:hps:${event.id}:${nowSec - HOLD_RATE_WINDOW_SEC + 1 + i}`);

    const [orders, holds, recent, perSecond, queue] = await Promise.all([
      deps.db.query<{ status: OrderStatus; n: number }>(
        'SELECT status::text AS status, count(*) AS n FROM orders WHERE event_id = $1 GROUP BY status',
        [event.id],
      ),
      deps.db.query<{ n: number }>(
        `SELECT count(*) AS n FROM holds WHERE event_id = $1 AND status = 'active' AND expires_at > now()`,
        [event.id],
      ),
      deps.db.query<{
        id: string;
        user_name: string;
        seats: number;
        amount_paise: number;
        status: OrderStatus;
        created_at: Date;
      }>(
        `SELECT o.id, u.name AS user_name, cardinality(h.seat_ids) AS seats, o.amount_paise,
                o.status::text AS status, o.created_at
         FROM orders o JOIN users u ON u.id = o.user_id JOIN holds h ON h.id = o.hold_id
         WHERE o.event_id = $1 ORDER BY o.created_at DESC LIMIT 10`,
        [event.id],
      ),
      deps.redis.mget(secondKeys),
      event.queue_enabled ? getQueueCounters(deps, event.id) : null,
    ]);
    const orderCount = (status: OrderStatus) => orders.rows.find((r) => r.status === status)?.n ?? 0;

    const dashboard: Dashboard = {
      event: toSummary(event),
      counts: {
        available: event.available,
        held: event.total - event.available - event.sold,
        sold: event.sold,
        total: event.total,
      },
      revenuePaise: event.revenue,
      ordersPaid: orderCount('paid'),
      ordersFailed: orderCount('failed'),
      ordersPending: orderCount('pending_payment'),
      activeHolds: holds.rows[0]!.n,
      queue,
      holdsPerSecond: perSecond.map((v) => Number(v ?? 0)),
      recentOrders: recent.rows.map((r) => ({
        id: r.id,
        userName: r.user_name,
        seats: r.seats,
        amountPaise: r.amount_paise,
        status: r.status,
        createdAt: r.created_at.toISOString(),
      })),
    };
    res.json(dashboard);
  });

  router.post('/events/:id/reopen-sale', async (req, res) => {
    const { opensInSec } = parse(ReopenSaleSchema, req.body);
    const event = await requireEvent(req.params.id);
    const opensAt = new Date(Date.now() + opensInSec * 1000);
    if (opensAt.getTime() >= event.starts_at.getTime()) {
      throw new AppError('VALIDATION_FAILED', 'The sale cannot reopen after the event starts');
    }
    await deps.db.query('UPDATE events SET sale_opens_at = $2 WHERE id = $1', [event.id, opensAt]);
    await clearQueue(deps, event.id);
    res.json({ event: toAdminRow(await requireEvent(event.id)) });
  });

  router.post('/events/:id/simulate-crowd', async (req, res) => {
    const { count } = parse(SimulateCrowdSchema, req.body);
    const event = await requireEvent(req.params.id);
    if (!event.queue_enabled) throw new AppError('VALIDATION_FAILED', 'This event has no waiting room');
    res.json({ queueLength: await simulateCrowd(deps, event.id, count) });
  });

  router.post('/events/:id/bench-reset', async (req, res) => {
    if (!deps.config.benchMode) throw new AppError('NOT_FOUND', 'No such route');
    const event = await requireEvent(req.params.id);
    await releaseHoldsForEvent(deps, event.id);
    await clearQueue(deps, event.id);
    res.status(204).end();
  });

  router.post('/checkin', async (req, res) => {
    const { code } = parse(CheckinSchema, req.body);
    const { rows } = await deps.db.query<{
      id: string;
      checked_in_at: Date | null;
      section_key: string;
      row_label: string;
      seat_number: number;
      tier: string;
      price_paise: number;
      title: string;
      layout: VenueLayout;
    }>(
      `SELECT t.id, t.checked_in_at, s.section_key, s.row_label, s.seat_number, s.tier, s.price_paise,
              e.title, v.layout
       FROM tickets t
       JOIN event_seats s ON s.id = t.event_seat_id
       JOIN events e ON e.id = t.event_id
       JOIN venues v ON v.id = e.venue_id
       WHERE t.code = $1`,
      [code],
    );
    const ticket = rows[0];
    if (!ticket) throw new AppError('NOT_FOUND', 'No ticket with this code');

    // Only one of two simultaneous scans of the same ticket can win this UPDATE.
    const claimed = await deps.db.query<{ checked_in_at: Date }>(
      'UPDATE tickets SET checked_in_at = now() WHERE id = $1 AND checked_in_at IS NULL RETURNING checked_in_at',
      [ticket.id],
    );
    const checkedInAt = claimed.rows[0]?.checked_in_at ?? ticket.checked_in_at!;
    const sectionName = ticket.layout.sections.find((s) => s.key === ticket.section_key)?.name ?? ticket.section_key;
    const label = seatLabel(sectionName, ticket.row_label, ticket.seat_number);

    const result: CheckinResult = {
      ticket: {
        id: ticket.id,
        code,
        seatLabel: label,
        tier: ticket.tier,
        pricePaise: ticket.price_paise,
        checkedInAt: checkedInAt.toISOString(),
      },
      seatLabel: label,
      eventTitle: ticket.title,
      alreadyCheckedIn: claimed.rowCount === 0,
    };
    res.json(result);
  });

  return router;
}
