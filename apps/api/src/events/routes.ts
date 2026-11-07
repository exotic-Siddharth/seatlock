import { CategorySchema, type SeatCode, type SeatSnapshot, type SeatTuple } from '@seatlock/shared';
import { Router } from 'express';
import { z } from 'zod';
import { getActiveHoldForUser } from '../booking/holds.service';
import type { AppDeps } from '../context';
import { AppError } from '../errors';
import { parse } from '../http';
import { eventExists, findEventBySlug, listPublicEvents, seatCounts, toDetail, toSummary } from './queries';
import { EFFECTIVE_STATUS_SQL } from './status';

const ListQuerySchema = z.object({ category: CategorySchema.optional() });

const SEAT_CODE_SQL = `(CASE ${EFFECTIVE_STATUS_SQL('s')} WHEN 'held' THEN 'H' WHEN 'sold' THEN 'S' ELSE 'A' END)`;

export function eventsRouter(deps: AppDeps): Router {
  const router = Router();

  // The hub sends this to every SSE client of an event every 2 s, so the live counters stay right
  // even if a seat message is missed.
  deps.hub.setStatsProvider((eventId) => seatCounts(deps.db, eventId));

  const requireEvent = async (id: string) => {
    if (!(await eventExists(deps.db, id))) throw new AppError('NOT_FOUND', 'Event not found');
  };

  router.get('/', async (req, res) => {
    const { category } = parse(ListQuerySchema, req.query);
    const rows = await listPublicEvents(deps.db, category);
    res.json({ items: rows.map(toSummary) });
  });

  router.get('/:slug', async (req, res) => {
    const row = await findEventBySlug(deps.db, req.params.slug);
    if (!row) throw new AppError('NOT_FOUND', 'Event not found');
    res.json({ event: toDetail(row) });
  });

  router.get('/:id/seats', async (req, res) => {
    const { id } = req.params;
    await requireEvent(id);
    // A compact array per seat: this response is fetched by every visitor and holds up to 10,000 seats.
    const [seats, myHold] = await Promise.all([
      deps.db.query<SeatTuple>({
        text: `SELECT s.id, s.section_key, s.row_label, s.seat_number, s.tier, ${SEAT_CODE_SQL}
               FROM event_seats s WHERE s.event_id = $1 ORDER BY s.id`,
        values: [id],
        rowMode: 'array',
      }),
      req.user ? getActiveHoldForUser(deps.db, req.user.id, id) : null,
    ]);
    const snapshot: SeatSnapshot = {
      eventId: id,
      serverTime: new Date().toISOString(),
      seats: seats.rows as unknown as [number, string, string, number, string, SeatCode][],
      myHold,
    };
    res.set('Cache-Control', 'no-store').json(snapshot);
  });

  router.get('/:id/stream', async (req, res) => {
    await requireEvent(req.params.id);
    deps.hub.addClient(req.params.id, res);
  });

  return router;
}
