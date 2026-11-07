import { Router } from 'express';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B1 implements these. Mounted at /api/holds (spec §7.1, §9).

const notImplemented = () => {
  throw new AppError('INTERNAL', 'not implemented');
};

export function holdsRouter(_deps: AppDeps): Router {
  const router = Router();
  router.post('/', notImplemented);
  router.get('/:id', notImplemented);
  router.delete('/:id', notImplemented);
  return router;
}
