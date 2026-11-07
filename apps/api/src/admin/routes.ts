import { Router } from 'express';
import { requireAdmin } from '../auth/middleware';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B2 implements these. Mounted at /api/admin; every route is admin-only.
// bench-reset answers 404 unless BENCH_MODE is on.

const notImplemented = () => {
  throw new AppError('INTERNAL', 'not implemented');
};

export function adminRouter(_deps: AppDeps): Router {
  const router = Router();
  router.use(requireAdmin);
  router.get('/venues', notImplemented);
  router.get('/events', notImplemented);
  router.post('/events', notImplemented);
  router.patch('/events/:id', notImplemented);
  router.get('/events/:id/dashboard', notImplemented);
  router.post('/events/:id/reopen-sale', notImplemented);
  router.post('/events/:id/simulate-crowd', notImplemented);
  router.post('/events/:id/bench-reset', notImplemented);
  router.post('/checkin', notImplemented);
  return router;
}
