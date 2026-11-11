import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { loadConfig } from '../config';
import { createPool } from '../db';
import { isMain } from './cli';

/** apps/api/migrations, reached the same way from src/scripts (tsx) and dist/scripts (bundled). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

// Session-level advisory lock so two replicas starting together never migrate at once.
const MIGRATION_LOCK = 72_201_107;

/**
 * Applies `NNN_name.sql` files in order, each in its own transaction, and records them in
 * schema_migrations. Already-applied files are skipped, so running it again is a no-op.
 * Returns the names it applied.
 */
export async function migrate(db: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    const applied: string[] = [];
    for (const file of files.filter((f) => !done.has(f))) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

if (isMain(import.meta.url)) {
  const db = createPool(loadConfig());
  try {
    const applied = await migrate(db);
    console.log(applied.length > 0 ? `Applied ${applied.join(', ')}` : 'Database is up to date');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
