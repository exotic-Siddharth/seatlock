import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../context';

// Renew or release the lock only while we still own it (compare-and-renew / compare-and-delete).
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/**
 * Runs `fn` every `intervalMs` on whichever instance holds the Redis lock `sl:leader:{name}`.
 * Every instance calls this; the others keep trying to take the lock, which expires after
 * 3 intervals if the leader dies. Returns a function that stops the loop and frees the lock.
 */
export function runAsLeader(
  deps: Pick<AppDeps, 'redis' | 'log'>,
  name: string,
  intervalMs: number,
  fn: () => Promise<void>,
): () => void {
  const key = `sl:leader:${name}`;
  const instanceId = randomUUID();
  const ttlMs = intervalMs * 3;
  let leader = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const claim = async (): Promise<boolean> =>
    leader
      ? (await deps.redis.eval(RENEW, 1, key, instanceId, ttlMs)) === 1
      : (await deps.redis.set(key, instanceId, 'PX', ttlMs, 'NX')) === 'OK';

  const tick = async () => {
    try {
      leader = await claim();
    } catch (err) {
      leader = false;
      deps.log.warn({ err, task: name }, 'leader lock check failed');
    }
    if (leader && !stopped) {
      try {
        await fn();
      } catch (err) {
        deps.log.error({ err, task: name }, 'leader task failed');
      }
    }
    if (!stopped) schedule(intervalMs);
  };

  const schedule = (ms: number) => {
    timer = setTimeout(() => void tick(), ms);
    timer.unref();
  };
  schedule(0);

  return () => {
    stopped = true;
    clearTimeout(timer);
    if (leader) deps.redis.eval(RELEASE, 1, key, instanceId).catch(() => undefined);
  };
}
