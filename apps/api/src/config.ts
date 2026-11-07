import { randomBytes } from 'node:crypto';
import { StrategyNameSchema, type StrategyName } from '@seatlock/shared';
import { z } from 'zod';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** Bare origin (no trailing slash) that cookie-authenticated mutations must come from. */
  webOrigin: string;
  sessionSecretPepper: string | undefined;
  queueTokenSecret: string;
  mockpayWebhookSecret: string;
  mockpayWebhookUrl: string;
  mockpayLatencyMs: { min: number; max: number };
  holdStrategy: StrategyName;
  /** Rate limits off and the X-Bench-Strategy header allowed. Load tests only. */
  benchMode: boolean;
  pgPoolMax: number;
  /** How long a query may wait for a pooled connection before it fails (ms). */
  pgConnectTimeoutMs: number;
  metricsToken: string;
  logLevel: LogLevel;
  cookieSecure: boolean;
  trustProxy: boolean;
  /** Names of secrets that were missing and generated for this process (never in production). */
  generatedSecrets: string[];
};

type SecretName = 'QUEUE_TOKEN_SECRET' | 'MOCKPAY_WEBHOOK_SECRET' | 'METRICS_TOKEN';
const MIN_SECRET_LENGTH = 32;

const flag = z
  .enum(['0', '1', 'false', 'true'], { message: 'expected 0, 1, false or true' })
  .default('0')
  .transform((v) => v === '1' || v === 'true');

const latencyRange = z
  .string()
  .default('300-900')
  .transform((value, ctx) => {
    const match = /^(\d+)-(\d+)$/.exec(value);
    const [min, max] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
    if (!(min <= max)) {
      ctx.addIssue({ code: 'custom', message: 'expected "min-max" in milliseconds with min <= max' });
      return z.NEVER;
    }
    return { min, max };
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4200),
  DATABASE_URL: z.string().url().default('postgres://seatlock:seatlock@localhost:55434/seatlock'),
  REDIS_URL: z.string().url().default('redis://localhost:56381/0'),
  WEB_ORIGIN: z
    .string()
    .url()
    .default('http://localhost:5175')
    .transform((v) => new URL(v).origin),
  SESSION_SECRET_PEPPER: z.string().optional(),
  QUEUE_TOKEN_SECRET: z.string().optional(),
  MOCKPAY_WEBHOOK_SECRET: z.string().optional(),
  METRICS_TOKEN: z.string().optional(),
  MOCKPAY_WEBHOOK_URL: z.string().url().default('http://localhost:4200/api/webhooks/mockpay'),
  MOCKPAY_LATENCY_MS: latencyRange,
  HOLD_STRATEGY: StrategyNameSchema.default('conditional'),
  BENCH_MODE: flag,
  PG_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  PG_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  COOKIE_SECURE: flag,
  TRUST_PROXY: flag,
});

type Env = z.infer<typeof EnvSchema>;

/** Production must supply every secret; elsewhere a missing one is generated for this process. */
function resolveSecrets(env: Env, problems: string[]) {
  const production = env.NODE_ENV === 'production';
  const generated: string[] = [];
  const value = (name: SecretName) => {
    const given = env[name];
    if (given !== undefined) {
      if (production && given.length < MIN_SECRET_LENGTH) problems.push(`${name}: must be at least ${MIN_SECRET_LENGTH} characters`);
      return given;
    }
    if (production) problems.push(`${name}: required in production`);
    generated.push(name);
    return randomBytes(32).toString('base64url');
  };
  const secrets = {
    queueTokenSecret: value('QUEUE_TOKEN_SECRET'),
    mockpayWebhookSecret: value('MOCKPAY_WEBHOOK_SECRET'),
    metricsToken: value('METRICS_TOKEN'),
  };
  const pepper = env.SESSION_SECRET_PEPPER;
  if (production && pepper !== undefined && pepper.length < MIN_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET_PEPPER: must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return { secrets, generated };
}

/** Reads and validates the environment (spec §9 "Config"). Throws one error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable (`FOO=`) means "use the default".
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${issues.join('\n  ')}`);
  }
  const e = parsed.data;

  const problems: string[] = [];
  const { secrets, generated } = resolveSecrets(e, problems);
  if (e.HOLD_STRATEGY === 'naive' && !e.BENCH_MODE) {
    problems.push('HOLD_STRATEGY: naive is only allowed with BENCH_MODE=1');
  }
  if (problems.length > 0) throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    webOrigin: e.WEB_ORIGIN,
    sessionSecretPepper: e.SESSION_SECRET_PEPPER,
    ...secrets,
    mockpayWebhookUrl: e.MOCKPAY_WEBHOOK_URL,
    mockpayLatencyMs: e.MOCKPAY_LATENCY_MS,
    holdStrategy: e.HOLD_STRATEGY,
    benchMode: e.BENCH_MODE,
    pgPoolMax: e.PG_POOL_MAX,
    pgConnectTimeoutMs: e.PG_CONNECT_TIMEOUT_MS,
    logLevel: e.LOG_LEVEL,
    cookieSecure: e.COOKIE_SECURE,
    trustProxy: e.TRUST_PROXY,
    generatedSecrets: generated,
  };
}
