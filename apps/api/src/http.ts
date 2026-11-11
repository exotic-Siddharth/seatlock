import type { ZodType, ZodTypeDef } from 'zod';
import { validationError } from './errors';

/**
 * Validates untrusted input (a body, params or query) against a shared schema and returns
 * the parsed value, or throws 400 VALIDATION_FAILED with the zod issues as `details`.
 */
export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw validationError(result.error.issues);
  return result.data;
}
