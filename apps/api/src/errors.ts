import { ERROR_STATUS, type ErrorBody, type ErrorCode } from '@seatlock/shared';
import type { ErrorRequestHandler } from 'express';
import { ZodError, type ZodIssue } from 'zod';

/** An error with an API error code. Thrown anywhere; rendered by `errorHandler`. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? defaultMessage(code));
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

/** 'HOLD_EXPIRED' -> 'Hold expired' */
function defaultMessage(code: ErrorCode): string {
  const words = code.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "seatIds: Seat ids must be distinct" */
export function describeIssue(issue: ZodIssue): string {
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

export function validationError(issues: ZodIssue[]): AppError {
  return new AppError('VALIDATION_FAILED', issues[0] ? describeIssue(issues[0]) : 'Invalid request', issues);
}

/** body-parser errors (malformed JSON, body too large) carry a 4xx `status` and a `type`. */
function isClientBodyError(err: unknown): err is { status: number; type: string } {
  if (typeof err !== 'object' || err === null) return false;
  const { status, type } = err as { status?: unknown; type?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && typeof type === 'string';
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return validationError(err.issues);
  if (isClientBodyError(err)) {
    return new AppError('VALIDATION_FAILED', err.type === 'entity.too.large' ? 'Request body too large' : 'Malformed request body');
  }
  return new AppError('INTERNAL', 'Something went wrong');
}

/** Renders every error as `{error: {code, message, details?}}`. Unexpected errors are logged and hidden. */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const appError = toAppError(err);
  if (appError.code === 'INTERNAL') req.log?.error({ err }, 'request failed');

  const body: ErrorBody = { error: { code: appError.code, message: appError.message } };
  if (appError.details !== undefined) body.error.details = appError.details;
  res.status(appError.status).json(body);
};
