import type { HoldStatus, StrategyName } from '@seatlock/shared';
import type { AppDeps } from '../../context';

/** A row of `holds`. */
export type HoldRow = {
  id: string;
  eventId: string;
  userId: string;
  seatIds: number[];
  amountPaise: number;
  strategy: StrategyName;
  status: HoldStatus;
  expiresAt: Date;
  createdAt: Date;
};

export type HoldInput = { eventId: string; userId: string; seatIds: number[]; ttlSec: number };

/** A seat set back to available when its hold ended, with the hold that had it. */
export type FreedSeat = { id: number; eventId: string; holdId: string };

export type HoldSuccess = {
  ok: true;
  hold: HoldRow;
  /** The seats of the user's previous hold on the event, which this hold released. */
  freed: FreedSeat[];
};

export type HoldResult = HoldSuccess | { ok: false; takenSeatIds: number[] };

export type StrategyDeps = Pick<AppDeps, 'db' | 'redis'>;

/**
 * One way of turning "these seats, if free" into a hold (spec §7.1). Every strategy is
 * all-or-nothing: it holds every requested seat or none, and reports the ones it couldn't get.
 */
export interface HoldStrategy {
  name: StrategyName;
  hold(deps: StrategyDeps, input: HoldInput): Promise<HoldResult>;
}
