import type { Request, RequestHandler } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export type Metrics = {
  registry: Registry;
  /** result: ok | conflict | error */
  holdAttempts: Counter<'strategy' | 'result'>;
  holdDuration: Histogram<'strategy'>;
  orders: Counter<'status'>;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  sseClients: Gauge;
  queueLength: Gauge<'event'>;
};

/** The Prometheus metrics of spec §9, on a registry of their own (so tests can build many). */
export function createMetrics(): Metrics {
  const registry = new Registry();
  const registers = [registry];
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    holdAttempts: new Counter({
      name: 'seatlock_hold_attempts_total',
      help: 'Seat hold attempts by strategy and result (ok, conflict, error).',
      labelNames: ['strategy', 'result'],
      registers,
    }),
    holdDuration: new Histogram({
      name: 'seatlock_hold_duration_seconds',
      help: 'Time to take or reject a seat hold, by strategy.',
      labelNames: ['strategy'],
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers,
    }),
    orders: new Counter({
      name: 'seatlock_orders_total',
      help: 'Orders by final status.',
      labelNames: ['status'],
      registers,
    }),
    httpDuration: new Histogram({
      name: 'seatlock_http_request_duration_seconds',
      help: 'HTTP request duration by method, route pattern and status.',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    }),
    sseClients: new Gauge({
      name: 'seatlock_sse_clients',
      help: 'Open seat-map SSE connections on this instance.',
      registers,
    }),
    queueLength: new Gauge({
      name: 'seatlock_queue_length',
      help: 'People in the waiting room, by event id.',
      labelNames: ['event'],
      registers,
    }),
  };
}

/** The matched route pattern (e.g. /api/holds/:id), never the raw URL, to keep label cardinality low. */
function routeLabel(req: Request): string {
  const path: unknown = req.route?.path;
  return typeof path === 'string' ? `${req.baseUrl}${path}` : 'unmatched';
}

export function httpMetrics(metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    const end = metrics.httpDuration.startTimer();
    res.on('finish', () => end({ method: req.method, route: routeLabel(req), status: String(res.statusCode) }));
    next();
  };
}
