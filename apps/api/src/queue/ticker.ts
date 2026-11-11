import type { AppDeps } from '../context';
import { runAsLeader } from '../infra/leader';
import { QUEUE_KEY_TTL_SEC, queueKeys } from './service';

// Raises `admitted` by the event's rate, never past the queue length. One script, so the cap
// and the rejoin logic in service.ts (which lowers `admitted`) cannot interleave.
// KEYS: queue, admitted. ARGV: rate, ttl (s). Returns {admitted, queue length}.
const ADMIT = `
local length = redis.call('ZCARD', KEYS[1])
local admitted = math.min(tonumber(redis.call('GET', KEYS[2]) or '0') + tonumber(ARGV[1]), length)
redis.call('SET', KEYS[2], admitted, 'EX', ARGV[2])
return {admitted, length}`;

/** Starts the admission ticker (1 s, leader only); returns a function that stops it. */
export function startQueueTicker(deps: AppDeps): () => void {
  return runAsLeader(deps, 'queue-ticker', 1_000, () => tickQueuesOnce(deps));
}

/** Admits `admit_rate_per_sec` more people in every queue-enabled event whose sale is open. */
export async function tickQueuesOnce(deps: AppDeps): Promise<void> {
  const { rows } = await deps.db.query<{ id: string; admit_rate_per_sec: number }>(
    `SELECT id, admit_rate_per_sec FROM events
     WHERE queue_enabled AND sale_opens_at <= now() AND starts_at > now()`,
  );
  for (const event of rows) {
    const keys = queueKeys(event.id);
    const [, length] = (await deps.redis.eval(
      ADMIT,
      2,
      keys.queue,
      keys.admitted,
      event.admit_rate_per_sec,
      QUEUE_KEY_TTL_SEC,
    )) as [number, number];
    deps.metrics.queueLength.set({ event: event.id }, length);
  }
}
