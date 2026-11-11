import { createHash, timingSafeEqual } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { Router, type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import { adminRouter } from './admin/routes';
import { csrfGuard, loadSession } from './auth/middleware';
import { authRouter } from './auth/routes';
import { holdsRouter } from './booking/holds.routes';
import { ordersRouter } from './booking/orders.routes';
import type { AppDeps } from './context';
import { AppError, errorHandler } from './errors';
import { eventsRouter } from './events/routes';
import { httpMetrics, rememberMountPath } from './infra/metrics';
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

  const healthz: RequestHandler = (_req, res) => {
    res.json({ status: 'ok' });
  };
  const readyz: RequestHandler = async (_req, res) => {
    const up = (check: Promise<unknown>) => check.then(() => 'ok' as const, () => 'down' as const);
    const [postgres, redis] = await Promise.all([up(deps.db.query('SELECT 1')), up(deps.redis.ping())]);
    const ready = postgres === 'ok' && redis === 'ok';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', postgres, redis });
  };
  for (const prefix of ['', '/api']) {
    router.get(`${prefix}/healthz`, healthz);
    router.get(`${prefix}/readyz`, readyz);
  }

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

  const mount = (path: string, ...handlers: RequestHandler[]) => app.use(path, rememberMountPath, ...handlers);

  app.use(cookieParser());
  app.use(loadSession(deps));
  // Webhook signatures cover the exact bytes sent, so this route gets the raw body, not parsed JSON.
  mount('/api/webhooks', express.raw({ type: 'application/json', limit: '64kb' }), webhookRouter(deps));
  app.use(express.json({ limit: '100kb' }));
  app.use(csrfGuard(deps.config));

  mount('/api/auth', authRouter(deps));
  mount('/api/stats', statsRouter(deps));
  mount('/api/events', eventsRouter(deps));
  mount('/api/events', queueRouter(deps)); // /api/events/:id/queue
  mount('/api/holds', holdsRouter(deps));
  mount('/api/orders', ordersRouter(deps));
  mount('/api/mockpay', mockpayRouter(deps));
  mount('/api/admin', adminRouter(deps));

  app.use(() => {
    throw new AppError('NOT_FOUND', 'No such route');
  });
  app.use(errorHandler);
  return app;
}
