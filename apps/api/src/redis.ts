import { Redis } from 'ioredis';
import type { Logger } from './logger';

export type { Redis };

export function createRedis(url: string, log?: Logger): Redis {
  // Fail a command after a few reconnect attempts instead of queueing it for ever.
  const redis = new Redis(url, { maxRetriesPerRequest: 3 });
  // ioredis reconnects by itself; without a listener every failed attempt prints a warning.
  redis.on('error', (err: Error) => log?.warn({ err: err.message }, 'Redis connection error'));
  return redis;
}
