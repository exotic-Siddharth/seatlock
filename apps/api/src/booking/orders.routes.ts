import { OrderRequestSchema } from '@seatlock/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware';
import type { AppDeps } from '../context';
import { parse } from '../http';
import { hashBody, requireIdempotencyKey, withIdempotency } from '../infra/idempotency';
import { rateLimit } from '../infra/rate-limit';
import { createOrder, getOrder, listOrders } from './orders.service';

const OrderIdSchema = z.string().uuid();

/** Mounted at /api/orders. */
export function ordersRouter(deps: AppDeps): Router {
  const router = Router();
  const limit = rateLimit(deps, { name: 'orders', limit: 20, windowSec: 60, by: 'user' });

  router.post('/', requireAuth, limit, async (req, res) => {
    const userId = currentUser(req).id;
    const key = requireIdempotencyKey(req);
    const body = parse(OrderRequestSchema, req.body);
    const result = await withIdempotency(
      deps.redis,
      { userId, route: 'orders', key, bodyHash: hashBody(body) },
      async () => ({ status: 201, body: await createOrder(deps, { userId, holdId: body.holdId, idempotencyKey: key }) }),
    );
    res.status(result.status).json(result.body);
  });

  router.get('/', requireAuth, async (req, res) => {
    res.json({ items: await listOrders(deps.db, currentUser(req).id) });
  });

  router.get('/:id', requireAuth, async (req, res) => {
    res.json({ order: await getOrder(deps.db, parse(OrderIdSchema, req.params.id), currentUser(req).id) });
  });

  return router;
}
