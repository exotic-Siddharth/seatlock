import { Router } from 'express';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B2 implements this. Mounted at /api/stats; responds with `Stats` (cached 2 s).

const notImplemented = () => {
  throw new AppError('INTERNAL', 'not implemented');
};

export function statsRouter(_deps: AppDeps): Router {
  const router = Router();
  router.get('/', notImplemented);
  return router;
}
