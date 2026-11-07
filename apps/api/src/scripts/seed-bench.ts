import type { AppDeps } from '../context';
import { AppError } from '../errors';
import { isMain, runScript } from './cli';

// Stub: lane L1 implements `npm run bench:seed -w @seatlock/api -- --users 5000` (spec §11).

export async function main(_deps: AppDeps, _args: string[]): Promise<unknown> {
  throw new AppError('INTERNAL', 'not implemented');
}

if (isMain(import.meta.url)) await runScript('bench:seed', main);
