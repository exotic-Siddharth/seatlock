import type pg from 'pg';
import type { DestinationStream } from 'pino';
import type { Config } from './config';
import { createPool } from './db';
import { createMetrics, type Metrics } from './infra/metrics';
import { createLogger, type Logger } from './logger';
import { createSeatPublisher, type SeatPublisher } from './realtime/publisher';
import { createSseHub, type SseHub } from './realtime/sse-hub';
import { createRedis, type Redis } from './redis';

/** Everything a route, service or background loop needs, created once per process (or per test). */
export interface AppDeps {
  config: Config;
  db: pg.Pool;
  /** Commands. */
  redis: Redis;
  /** Subscriber connection used by the SSE hub (a subscribed connection can't run other commands). */
  sub: Redis;
  log: Logger;
  hub: SseHub;
  publisher: SeatPublisher;
  metrics: Metrics;
}

export async function createDeps(config: Config, opts: { logDestination?: DestinationStream } = {}): Promise<AppDeps> {
  const log = createLogger(config, opts.logDestination);
  const db = createPool(config, log);
  const redis = createRedis(config.redisUrl, log);
  const sub = createRedis(config.redisUrl, log);
  const metrics = createMetrics();
  const hub = createSseHub(sub, log, metrics);
  await hub.start();
  return { config, db, redis, sub, log, hub, publisher: createSeatPublisher(redis), metrics };
}

export async function closeDeps(deps: AppDeps): Promise<void> {
  await deps.hub.stop();
  await Promise.allSettled([deps.db.end(), deps.redis.quit(), deps.sub.quit()]);
}
