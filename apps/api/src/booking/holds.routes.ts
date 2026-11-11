import { HoldRequestSchema, StrategyNameSchema, type StrategyName } from '@seatlock/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware';
import type { Config } from '../config';
import type { AppDeps } from '../context';
import { AppError } from '../errors';
import { parse } from '../http';
import { rateLimit } from '../infra/rate-limit';
import { createHold, getHold, releaseHold } from './holds.service';

const HoldIdSchema = z.string().uuid();

/** The configured strategy, or in bench mode the one named by X-Bench-Strategy (spec §7.1). */
function chooseStrategy(config: Config, header: string | undefined): StrategyName {
  if (header === undefined) return config.holdStrategy;
  if (!config.benchMode) throw new AppError('BENCH_ONLY', 'X-Bench-Strategy is only accepted in bench mode');
  return parse(StrategyNameSchema, header);
}

/** Mounted at /api/holds. */
export function holdsRouter(deps: AppDeps): Router {
  const router = Router();
  const limit = rateLimit(deps, { name: 'holds', limit: 30, windowSec: 60, by: 'user' });

  router.post('/', requireAuth, limit, async (req, res) => {
    const strategy = chooseStrategy(deps.config, req.get('x-bench-strategy'));
    const { eventId, seatIds } = parse(HoldRequestSchema, req.body);
    const hold = await createHold(deps, {
      userId: currentUser(req).id,
      eventId,
      seatIds,
      strategy,
      queueToken: req.get('x-queue-token'),
    });
    res.status(201).json({ hold });
  });

  router.get('/:id', requireAuth, async (req, res) => {
    const hold = await getHold(deps.db, parse(HoldIdSchema, req.params.id), currentUser(req).id);
    res.json({ hold });
  });

  router.delete('/:id', requireAuth, async (req, res) => {
    await releaseHold(deps, parse(HoldIdSchema, req.params.id), currentUser(req).id);
    res.status(204).end();
  });

  return router;
}
