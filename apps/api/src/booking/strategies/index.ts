import type { StrategyName } from '@seatlock/shared';
import { conditional } from './conditional';
import { naive } from './naive';
import { pessimistic } from './pessimistic';
import { redis } from './redis';
import type { HoldStrategy } from './types';

const STRATEGIES: Record<StrategyName, HoldStrategy> = { naive, pessimistic, conditional, redis };

/** The seat-locking strategy called `name` (spec §7.1). */
export function getStrategy(name: StrategyName): HoldStrategy {
  return STRATEGIES[name];
}
