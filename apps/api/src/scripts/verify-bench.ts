import { parseArgs } from 'node:util';
import { StrategyNameSchema } from '@seatlock/shared';
import { verifyEventWithTotals } from '../bench/verify';
import type { AppDeps } from '../context';
import { isMain, runScript } from './cli';

/**
 * `npm run bench:verify -w @seatlock/api -- --event bench-hot --strategy conditional` (spec §11).
 * Prints the invariants as JSON (plus ticketsSold and seatsTotal) and exits 0 whether or not they
 * pass: the runner records a failing naive run, and fails the benchmark for any other strategy.
 *   --event SLUG_OR_ID   the event to check
 *   --strategy NAME      the strategy the run used (naive tolerates double-promised seats; default conditional)
 */
export async function main(deps: AppDeps, args: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args,
    options: { event: { type: 'string' }, strategy: { type: 'string', default: 'conditional' } },
  });
  if (!values.event) throw new Error('--event <slug or id> is required');
  const strategy = StrategyNameSchema.parse(values.strategy);

  const { rows } = await deps.db.query<{ id: string; slug: string }>(
    'SELECT id, slug FROM events WHERE slug = $1 OR id::text = $1',
    [values.event],
  );
  const event = rows[0];
  if (!event) throw new Error(`No event with slug or id "${values.event}"`);

  const result = await verifyEventWithTotals(deps.db, event.id, { strategy });
  return { event: event.slug, strategy, ...result };
}

if (isMain(import.meta.url)) await runScript('bench:verify', main);
