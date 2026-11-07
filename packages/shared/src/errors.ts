/** HTTP status for every API error code (spec §9). */
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  BAD_SIGNATURE: 400,
  STALE_WEBHOOK: 400,
  BENCH_ONLY: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  CSRF_FAILED: 403,
  QUEUE_REQUIRED: 403,
  QUEUE_TOKEN_INVALID: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  SALE_NOT_OPEN: 409,
  SALE_CLOSED: 409,
  SEATS_UNAVAILABLE: 409,
  CHECKOUT_IN_PROGRESS: 409,
  HOLD_NOT_ACTIVE: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  HOLD_EXPIRED: 410,
  TOO_MANY_SEATS: 422,
  IDEMPOTENCY_MISMATCH: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

/** The body of every non-2xx API response. */
export type ErrorBody = {
  error: { code: ErrorCode; message: string; details?: unknown };
};
