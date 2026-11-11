import pg from 'pg';
import { pgCode } from '../src/db';
import { migrate } from '../src/scripts/migrate';
import { testConfig, withUrlPath } from './helpers';

/** Creates the test database if it is missing, then applies pending migrations. Runs once per `vitest run`. */
export default async function setup(): Promise<void> {
  const { databaseUrl } = testConfig();
  const dbName = new URL(databaseUrl).pathname.slice(1);

  const admin = new pg.Client({ connectionString: withUrlPath(databaseUrl, 'postgres') });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    // dbName is validated in helpers.ts ([a-z0-9_]), so quoting it is safe.
    if (!rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  } catch (e) {
    if (pgCode(e) !== '42P04') throw e; // created concurrently by another run
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
