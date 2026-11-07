import { Router } from 'express';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B2 implements these. Mounted at /api/events, next to eventsRouter (spec §8).

const notImplemented = () => {
  throw new AppError('INTERNAL', 'not implemented');
};

export function queueRouter(_deps: AppDeps): Router {
  const router = Router();
  router.get('/:id/queue', notImplemented);
  router.post('/:id/queue', notImplemented);
  return router;
}
