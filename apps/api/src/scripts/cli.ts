import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { loadConfig } from '../config';
import { closeDeps, createDeps, type AppDeps } from '../context';

/** True when the module at `moduleUrl` is the file Node was started with, rather than an import. */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const canonical = (p: string) => {
    const real = realpathSync(p);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  try {
    return canonical(fileURLToPath(moduleUrl)) === canonical(path.resolve(entry));
  } catch {
    return false;
  }
}

/** A script body: gets fresh deps and the CLI arguments; a returned value is printed as JSON. */
export type ScriptMain = (deps: AppDeps, args: string[]) => Promise<unknown>;

/**
 * Runs a script with its own deps. The result goes to stdout as JSON and logs go to stderr,
 * so the output can be piped. A failure sets exit code 1.
 */
export async function runScript(name: string, main: ScriptMain): Promise<void> {
  const deps = await createDeps(loadConfig(), { logDestination: pino.destination({ fd: 2, sync: true }) });
  try {
    const result = await main(deps, process.argv.slice(2));
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    deps.log.error({ err }, `${name} failed`);
    process.exitCode = 1;
  } finally {
    await closeDeps(deps);
  }
}
