import type { BenchSummary } from '@seatlock/shared';
import { FlaskConical } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, EmptyState } from '../../components/ui';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import { Results } from './Results';
import { StrategyCard } from './StrategyCard';
import { STRATEGIES } from './strategies';

function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-14">
      <h2 id={id} className="font-display text-2xl font-bold">
        {title}
      </h2>
      {intro && <p className="mt-2 max-w-3xl text-muted">{intro}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

const LAYERS: [string, string][] = [
  ['The hold strategy', 'Decides who gets a seat when several people ask at once. This is the part the benchmark compares.'],
  ['Ownership checks', 'A sale only converts seats that are still held by that exact hold, so a stale or foreign hold cannot sell them.'],
  ['A UNIQUE constraint', 'A seat can have at most one ticket. If everything above fails, the database refuses the second ticket.'],
  ['Signed, idempotent webhooks', 'Payment results arrive over a signed webhook that is recorded once, so a replay or a duplicate changes nothing.'],
];

/** The Lab page body. `summary` is the committed benchmark file, or null when there is none. */
export function LabContent({ summary }: { summary: BenchSummary | null }) {
  return (
    <div>
      <header>
        <p className="flex items-center gap-2 text-sm font-semibold tracking-wide text-accent uppercase">
          <FlaskConical aria-hidden className="size-4" /> Lab
        </p>
        <h1 className="mt-2 font-display text-4xl font-bold tracking-tight">How Seatlock stays correct</h1>
        <p className="mt-3 max-w-3xl text-lg text-muted">
          When a sale opens, thousands of people ask for the same seats in the same second. Seatlock must never sell one seat twice, and
          it should stay fast and fair while it does. This page shows how, and measures it.
        </p>
      </header>

      <Section
        id="architecture"
        title="Architecture"
        intro="Postgres is the single source of truth. Redis holds everything that is fast and disposable. Two identical API replicas sit behind nginx, so correctness cannot depend on one process remembering anything."
      >
        <Card className="p-4 sm:p-6">
          <ArchitectureDiagram />
        </Card>
        <ul className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
          <li>
            <strong>Live seat map.</strong> After each commit the API publishes seat changes to Redis. Every replica relays them to its
            browsers over server-sent events, batched, so the map updates without polling.
          </li>
          <li>
            <strong>Background work.</strong> Expiring old holds and admitting people from the waiting room run in every replica, but
            only the one holding a Redis leader lock does the work.
          </li>
          <li>
            <strong>Payments.</strong> MockPay stands in for an external provider. It calls the API back with a signed webhook, and the API
            never trusts the browser about whether a payment succeeded.
          </li>
          <li>
            <strong>Waiting room.</strong> Early arrivals get a random place, later ones queue in order, and admission is rate-limited
            so the booking path sees a steady stream instead of a stampede.
          </li>
        </ul>
      </Section>

      <Section
        id="strategies"
        title="Four ways to hold a seat"
        intro="All four sit behind one interface and are benchmarked under identical load. The default is conditional. The naive one exists only so the benchmark can show what going wrong looks like."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          {STRATEGIES.map((strategy) => (
            <StrategyCard key={strategy.name} strategy={strategy} />
          ))}
        </div>
        <p className="mt-4 text-sm text-muted">
          In the SQL, <code className="rounded bg-surface-2 px-1">$avail</code> means{' '}
          <code className="rounded bg-surface-2 px-1">status = 'available' OR (status = 'held' AND held_until &lt;= now())</code>, so an
          expired hold counts as free even before the sweeper clears it.
        </p>
      </Section>

      <Section id="defence" title="Defence in depth" intro="Correctness never rests on a single layer.">
        <ol className="grid gap-4 sm:grid-cols-2">
          {LAYERS.map(([name, text], i) => (
            <li key={name}>
              <Card className="flex h-full gap-4 p-5">
                <span aria-hidden className="font-display text-3xl font-bold text-accent">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-display text-lg font-semibold">{name}</h3>
                  <p className="mt-1 text-sm text-muted">{text}</p>
                </div>
              </Card>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="results" title="Benchmark results">
        {summary ? (
          <Results summary={summary} />
        ) : (
          <Card>
            <EmptyState
              icon={<FlaskConical aria-hidden />}
              title="No benchmark results committed yet"
              body={
                <>
                  <p>Run the benchmark on your machine, then rebuild the site. It writes loadtest/results/summary.json, which this page reads.</p>
                  <p className="mt-3">
                    <code className="rounded bg-surface-2 px-2 py-1 text-sm text-ink">bash loadtest/run-bench.sh</code>
                  </p>
                </>
              }
            />
          </Card>
        )}
      </Section>
    </div>
  );
}
