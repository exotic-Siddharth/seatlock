import { Router, type RequestHandler } from 'express';
import { currentUser, requireAuth } from '../auth/middleware';
import type { AppDeps } from '../context';
import { AppError } from '../errors';
import { rateLimit } from '../infra/rate-limit';
import { getQueueEvent, getQueueStatus, joinQueue } from './service';

export function queueRouter(deps: AppDeps): Router {
  const router = Router();
  // Clients poll about every 3 s (+-20 %), so 60/min leaves room for a refresh and a rejoin.
  const guard = [requireAuth, rateLimit(deps, { name: 'queue', limit: 60, windowSec: 60, by: 'user' })];

  const handler =
    (action: typeof getQueueStatus): RequestHandler =>
    async (req, res) => {
      const event = await getQueueEvent(deps.db, req.params.id as string);
      if (!event) throw new AppError('NOT_FOUND', 'Event not found');
      res.json({ queue: await action(deps, event, currentUser(req).id) });
    };

  router.get('/:id/queue', ...guard, handler(getQueueStatus));
  router.post('/:id/queue', ...guard, handler(joinQueue));
  return router;
}
