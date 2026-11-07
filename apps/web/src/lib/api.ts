import type { ErrorBody, ErrorCode } from '@seatlock/shared';

export type ApiErrorCode = ErrorCode | 'NETWORK_ERROR';

/** A failed API call: the HTTP status (0 when the server was unreachable) and the error body. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ApiInit = {
  /** Defaults to POST when there is a body, GET otherwise. */
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * Calls the API with the session cookie. `path` is the full path from the API table,
 * e.g. `api<{ items: EventSummary[] }>('/api/events')`. Resolves with the parsed JSON
 * (undefined for 204) and throws ApiError for any non-2xx response or network failure.
 */
export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error(`api() takes a path that starts with /api/, got "${path}"`);

  const hasBody = init.body !== undefined;
  const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
  if (hasBody) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (hasBody ? 'POST' : 'GET'),
      headers,
      body: hasBody ? JSON.stringify(init.body) : undefined,
      credentials: 'include',
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach Seatlock. Check your connection and try again.');
  }

  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const error = (data as Partial<ErrorBody> | undefined)?.error;
    throw new ApiError(res.status, error?.code ?? 'INTERNAL', error?.message ?? `Request failed (${res.status})`, error?.details);
  }
  return data as T;
}

/** A new key for the Idempotency-Key header: one per user intent, reused on retries of it. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** A message fit to show a person, for any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}
