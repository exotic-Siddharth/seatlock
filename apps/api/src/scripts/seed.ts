import { randomUUID } from 'node:crypto';
import { layoutCapacity } from '@seatlock/shared';
import { hashPassword } from '../auth/password';
import type { AppDeps } from '../context';
import type { Queryable } from '../db';
import { createEventWithSeats } from '../events/create';
import { SEED_EVENTS } from '../seed/events';
import { SEED_VENUES } from '../seed/venues';
import { isMain, runScript } from './cli';

// Idempotent dev seed: run it as often as you like. Existing rows are left alone, so
// a second run changes nothing (to get a fresh flash sale, use "Reopen sale" in the admin).

const DEV_ADMIN_PASSWORD = 'seatlock-admin-2026';
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

async function ensureUser(
  db: Queryable,
  user: { email: string; name: string; role: 'user' | 'admin'; password: string },
): Promise<void> {
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE email = $1', [user.email]);
  if (rowCount === 1) return;
  await db.query(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
    [user.email, user.name, await hashPassword(user.password), user.role],
  );
}

type SeedSummary = { users: number; venues: number; eventsCreated: number; eventsExisting: number };

export async function seed(deps: AppDeps): Promise<SeedSummary> {
  const adminPassword =
    process.env.SEED_ADMIN_PASSWORD ?? (deps.config.nodeEnv === 'production' ? undefined : DEV_ADMIN_PASSWORD);
  if (!adminPassword) throw new Error('Set SEED_ADMIN_PASSWORD to seed the admin account in production');

  await ensureUser(deps.db, { email: 'admin@seatlock.dev', name: 'Box Office Admin', role: 'admin', password: adminPassword });
  // The demo user is never signed in with a password: POST /api/auth/demo opens its session.
  await ensureUser(deps.db, { email: 'demo@seatlock.dev', name: 'Demo Fan', role: 'user', password: randomUUID() + randomUUID() });

  const venueIds = new Map<string, string>();
  for (const venue of SEED_VENUES) {
    await deps.db.query(
      `INSERT INTO venues (slug, name, city, layout, capacity) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slug) DO NOTHING`,
      [venue.slug, venue.name, venue.city, JSON.stringify(venue.layout), layoutCapacity(venue.layout)],
    );
    const { rows } = await deps.db.query<{ id: string }>('SELECT id FROM venues WHERE slug = $1', [venue.slug]);
    venueIds.set(venue.slug, rows[0]!.id);
  }

  const now = Date.now();
  let eventsCreated = 0;
  for (const event of SEED_EVENTS) {
    // The seed names its events by title; titles are unique within it.
    const existing = await deps.db.query('SELECT 1 FROM events WHERE title = $1', [event.title]);
    if (existing.rowCount === 1) continue;
    await createEventWithSeats(deps.db, {
      title: event.title,
      subtitle: event.subtitle,
      description: event.description,
      category: event.category,
      venueId: venueIds.get(event.venueSlug)!,
      startsAt: new Date(now + event.startsInDays * DAY_MS).toISOString(),
      saleOpensAt: new Date(now + event.saleOpensInMin * MINUTE_MS).toISOString(),
      tierPrices: event.tierPrices,
      queueEnabled: event.queueEnabled,
      admitRatePerSec: event.admitRatePerSec,
      posterHue: event.posterHue,
    });
    eventsCreated++;
  }

  return { users: 2, venues: SEED_VENUES.length, eventsCreated, eventsExisting: SEED_EVENTS.length - eventsCreated };
}

if (isMain(import.meta.url)) await runScript('seed', (deps) => seed(deps));
