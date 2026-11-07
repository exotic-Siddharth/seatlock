import { Router } from 'express';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B1 implements this. Mounted at /api/webhooks BEFORE express.json(), behind
// express.raw({type: 'application/json'}), so `req.body` is the raw Buffer the signature covers.

const notImplemented = () => {
  throw new AppError('INTERNAL', 'not implemented');
};

export function webhookRouter(_deps: AppDeps): Router {
  const router = Router();
  router.post('/mockpay', notImplemented);
  return router;
}
