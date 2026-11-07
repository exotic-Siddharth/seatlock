/*
 * Holds expire lazily: a seat with status 'held' whose held_until has passed is available
 * to every reader and every strategy. The sweeper tidies such rows, but correctness never
 * waits for it. These fragments are the one place that rule is written in SQL.
 */

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

function column(alias: string, name: string): string {
  if (alias === '') return name;
  if (!IDENTIFIER.test(alias)) throw new Error(`Not a SQL alias: ${alias}`);
  return `${alias}.${name}`;
}

/** SQL expression giving a seat's effective status as text: 'available' | 'held' | 'sold'. Pass '' for no alias. */
export function EFFECTIVE_STATUS_SQL(alias = 's'): string {
  const status = column(alias, 'status');
  return `(CASE WHEN ${status} = 'held' AND ${column(alias, 'held_until')} <= now() THEN 'available' ELSE ${status}::text END)`;
}

/** SQL condition that is true when a seat can be taken. Pass '' for no alias. */
export function AVAILABLE_SQL(alias = 's'): string {
  const status = column(alias, 'status');
  return `(${status} = 'available' OR (${status} = 'held' AND ${column(alias, 'held_until')} <= now()))`;
}
