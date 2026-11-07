import type { AppDeps } from '../context';
import { AppError } from '../errors';
import { isMain, runScript } from './cli';

// Stub: lane B2 implements the idempotent dev seed (admin, demo user, venues, 7 events).

export async function seed(_deps: AppDeps): Promise<void> {
  throw new AppError('INTERNAL', 'not implemented');
}

if (isMain(import.meta.url)) await runScript('seed', (deps) => seed(deps));
