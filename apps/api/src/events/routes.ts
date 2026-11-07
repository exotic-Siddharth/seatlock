import { Router } from 'express';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B2 implements these. Mounted at /api/events. The stream route hands the
// response to `deps.hub.addClient(eventId, res)` and calls `deps.hub.setStatsProvider` once.

const notImplemented = () => {
  throw new AppError('INTERNAL', 'not implemented');
};

export function eventsRouter(_deps: AppDeps): Router {
  const router = Router();
  router.get('/', notImplemented);
  router.get('/:slug', notImplemented);
  router.get('/:id/seats', notImplemented);
  router.get('/:id/stream', notImplemented);
  return router;
}
