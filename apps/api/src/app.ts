import { createHash, timingSafeEqual } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { adminRouter } from './admin/routes';
import { csrfGuard, loadSession } from './auth/middleware';
import { authRouter } from './auth/routes';
import { holdsRouter } from './booking/holds.routes';
import { ordersRouter } from './booking/orders.routes';
import type { AppDeps } from './context';
import { AppError, errorHandler } from './errors';
import { eventsRouter } from './events/routes';
import { httpMetrics } from './infra/metrics';
import { httpLogger } from './logger';
import { mockpayRouter } from './payments/mockpay.routes';
import { webhookRouter } from './payments/webhook.routes';
import { queueRouter } from './queue/routes';
import { statsRouter } from './stats/routes';

/** Constant-time string comparison (hashing first makes the lengths equal). */
function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Liveness, readiness and Prometheus metrics. Health answers under /api too, for the dev proxy. */
function systemRouter(deps: AppDeps): Router {
  const router = Router();

  router.get(['/healthz', '/api/healthz'], (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get(['/readyz', '/api/readyz'], async (_req, res) => {
    const up = (check: Promise<unknown>) => check.then(() => 'ok' as const, () => 'down' as const);
    const [postgres, redis] = await Promise.all([up(deps.db.query('SELECT 1')), up(deps.redis.ping())]);
    const ready = postgres === 'ok' && redis === 'ok';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', postgres, redis });
  });

  router.get('/metrics', async (req, res) => {
    if (!safeEqual(req.get('authorization') ?? '', `Bearer ${deps.config.metricsToken}`)) {
      throw new AppError('UNAUTHENTICATED', 'Metrics token required');
    }
    res.type(deps.metrics.registry.contentType).send(await deps.metrics.registry.metrics());
  });

  return router;
}

/** The HTTP app. No listening and no background loops, so tests can drive it with supertest. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set('trust proxy', deps.config.trustProxy ? 1 : false);

  app.use(helmet());
  app.use(httpLogger(deps.log));
  app.use(httpMetrics(deps.metrics));
  app.use(systemRouter(deps));

  app.use(cookieParser());
  app.use(loadSession(deps));
  // Webhook signatures cover the exact bytes sent, so this route gets the raw body, not parsed JSON.
  app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '64kb' }), webhookRouter(deps));
  app.use(express.json({ limit: '100kb' }));
  app.use(csrfGuard(deps.config));

  app.use('/api/auth', authRouter(deps));
  app.use('/api/stats', statsRouter(deps));
  app.use('/api/events', eventsRouter(deps));
  app.use('/api/events', queueRouter(deps)); // /api/events/:id/queue
  app.use('/api/holds', holdsRouter(deps));
  app.use('/api/orders', ordersRouter(deps));
  app.use('/api/mockpay', mockpayRouter(deps));
  app.use('/api/admin', adminRouter(deps));

  app.use(() => {
    throw new AppError('NOT_FOUND', 'No such route');
  });
  app.use(errorHandler);
  return app;
}
