import type { Stats } from '@seatlock/shared';
import { Router } from 'express';
import type { AppDeps } from '../context';

const CACHE_MS = 2_000;

async function loadStats(deps: AppDeps): Promise<Stats> {
  const { rows } = await deps.db.query<Stats>(
    `SELECT (SELECT count(*) FROM tickets) AS "ticketsSold",
            (SELECT count(*) FROM events WHERE listed AND sale_opens_at <= now() AND starts_at > now()) AS "eventsOnSale",
            (SELECT count(*) FROM holds WHERE status = 'active' AND expires_at > now()) AS "activeHolds"`,
  );
  return rows[0]!;
}

export function statsRouter(deps: AppDeps): Router {
  const router = Router();

  // The home page of every visitor calls this, so one query serves all of them for 2 s. Sharing
  // the promise also means a burst of requests triggers a single query, not one each.
  let cached: { at: number; stats: Promise<Stats> } | undefined;

  router.get('/', async (_req, res) => {
    if (!cached || Date.now() - cached.at >= CACHE_MS) {
      const entry = { at: Date.now(), stats: loadStats(deps) };
      entry.stats.catch(() => {
        if (cached === entry) cached = undefined; // do not cache a failure
      });
      cached = entry;
    }
    res.json(await cached.stats);
  });

  return router;
}
