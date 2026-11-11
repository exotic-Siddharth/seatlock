import { Router } from 'express';
import { applyPaymentEvent } from '../booking/confirm';
import type { AppDeps } from '../context';
import { AppError } from '../errors';
import { parse } from '../http';
import { PaymentEventSchema } from './mockpay.service';
import { verifyWebhook } from './signature';

/**
 * Mounted at /api/webhooks, ahead of express.json(): `req.body` is the raw Buffer, because
 * the signature covers the exact bytes sent. Nothing is parsed until the signature checks out.
 */
export function webhookRouter(deps: AppDeps): Router {
  const router = Router();

  router.post('/mockpay', async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const nowSec = Math.floor(Date.now() / 1000);
    const verdict = verifyWebhook(deps.config.mockpayWebhookSecret, req.get('mockpay-signature') ?? '', raw, nowSec);
    if (verdict === 'bad_signature') throw new AppError('BAD_SIGNATURE', 'Webhook signature does not match');
    if (verdict === 'stale') throw new AppError('STALE_WEBHOOK', 'Webhook timestamp is too far from our clock');

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Webhook body is not JSON');
    }
    await applyPaymentEvent(deps, parse(PaymentEventSchema, payload));
    res.json({ received: true });
  });

  return router;
}
