import { Router } from 'express';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B1 implements this. Mounted at /api/mockpay (spec §7.2).

const notImplemented = () => {
  throw new AppError('INTERNAL', 'not implemented');
};

export function mockpayRouter(_deps: AppDeps): Router {
  const router = Router();
  router.post('/intents/:id/confirm', notImplemented);
  return router;
}
