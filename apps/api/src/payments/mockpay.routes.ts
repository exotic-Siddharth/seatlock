import { ConfirmPaymentSchema } from '@seatlock/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware';
import type { AppDeps } from '../context';
import { parse } from '../http';
import { hashBody, requireIdempotencyKey, withIdempotency } from '../infra/idempotency';
import { rateLimit } from '../infra/rate-limit';
import { confirmPayment } from './mockpay.service';

const IntentIdSchema = z.string().min(1).max(100);

/** Mounted at /api/mockpay. */
export function mockpayRouter(deps: AppDeps): Router {
  const router = Router();
  const limit = rateLimit(deps, { name: 'pay', limit: 20, windowSec: 60, by: 'user' });

  router.post('/intents/:id/confirm', requireAuth, limit, async (req, res) => {
    const userId = currentUser(req).id;
    const key = requireIdempotencyKey(req);
    const card = parse(ConfirmPaymentSchema, req.body);
    const intentId = parse(IntentIdSchema, req.params.id);
    // The idempotency record lives in Redis, so hash what identifies the attempt but never the
    // card number or CVC: a card number has too little entropy for a plain hash to hide it.
    const bodyHash = hashBody({ intentId, last4: card.cardNumber.slice(-4), expiry: card.expiry, name: card.name });

    const result = await withIdempotency(deps.redis, { userId, route: 'mockpay-confirm', key, bodyHash }, async () => ({
      status: 202,
      body: await confirmPayment(deps, { intentId, userId, cardNumber: card.cardNumber }),
    }));
    res.status(result.status).json(result.body);
  });

  return router;
}
