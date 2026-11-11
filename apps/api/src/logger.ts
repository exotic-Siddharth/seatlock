import { randomUUID } from 'node:crypto';
import { pino, type DestinationStream, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config';

export type { Logger };

/** Field names whose values must never reach a log line, at any of the first three levels. */
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'sessionToken',
  'queueToken',
  'cardNumber',
  'cvc',
  'secret',
  'webhookSecret',
];

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-queue-token"]',
  'req.headers["mockpay-signature"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export function createLogger(config: Pick<Config, 'logLevel'>, destination?: DestinationStream): Logger {
  const options = {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}

const QUIET_PATHS = new Set(['/healthz', '/readyz', '/api/healthz', '/api/readyz', '/metrics']);

/** Request logging. Headers pass through the logger's redaction, and bodies are never logged. */
export function httpLogger(log: Logger) {
  return pinoHttp({
    logger: log,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id = typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url ?? '') },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : 'info'),
  });
}
