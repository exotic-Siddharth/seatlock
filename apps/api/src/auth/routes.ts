import { Router } from 'express';
import type { AppDeps } from '../context';
import { AppError } from '../errors';

// Stub: lane B2 implements these. Mounted at /api/auth (spec §9 "Auth").

const notImplemented = () => {
  throw new AppError('INTERNAL', 'not implemented');
};

export function authRouter(_deps: AppDeps): Router {
  const router = Router();
  router.post('/register', notImplemented);
  router.post('/login', notImplemented);
  router.post('/demo', notImplemented);
  router.post('/logout', notImplemented);
  router.get('/me', notImplemented);
  return router;
}
