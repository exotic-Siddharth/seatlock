import { createServer } from 'node:http';
import { createApp } from './app';
import { startSweeper } from './booking/sweeper';
import { loadConfig } from './config';
import { closeDeps, createDeps } from './context';
import { startQueueTicker } from './queue/ticker';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();
const deps = await createDeps(config);
const { log } = deps;
for (const name of config.generatedSecrets) {
  log.warn(`${name} is not set; using a random value for this process`);
}

const server = createServer(createApp(deps));
server.once('error', (err) => {
  log.fatal({ err }, 'HTTP server failed');
  process.exit(1);
});
server.listen(config.port, () => {
  log.info({ port: config.port, holdStrategy: config.holdStrategy, benchMode: config.benchMode }, 'Seatlock API listening');
});

// Every instance runs the loops; a Redis leader lock makes only one of them do the work.
const stopLoops = [startSweeper(deps), startQueueTicker(deps)];

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();

  for (const stop of stopLoops) stop();
  await deps.hub.stop(); // ends the SSE streams, which would otherwise keep server.close() waiting
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDeps(deps);
  process.exit(0);
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));
