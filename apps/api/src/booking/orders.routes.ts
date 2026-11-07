import { Router } from 'express';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B1 implements these. Mounted at /api/orders (spec §7.2, §9).

const notImplemented = () => {
  throw new AppError('INTERNAL', 'not implemented');
};

export function ordersRouter(_deps: AppDeps): Router {
  const router = Router();
  router.post('/', notImplemented);
  router.get('/', notImplemented);
  router.get('/:id', notImplemented);
  return router;
}
