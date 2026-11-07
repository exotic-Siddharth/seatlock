import { EVENT_CATEGORIES, type Category } from '@seatlock/shared';
import { ArrowRight, CalendarSearch, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, EmptyState, Skeleton, buttonClass, cx, useToast } from '../components/ui';
import { EventCard } from '../features/events/EventCard';
import { LoadError } from '../features/events/LoadError';
import { useEvents, useStats } from '../features/events/queries';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatNumber } from '../lib/format';

const CATEGORY_LABELS: Record<Category, string> = { music: 'Music', comedy: 'Comedy', theatre: 'Theatre', sports: 'Sports', talk: 'Talk' };

const isCategory = (value: string | null): value is Category => EVENT_CATEGORIES.includes(value as Category);

/**
 * Decorative: a little auditorium in arcs around a stage, a few seats sold and two picked.
 * Drawn as one path per colour (a circle is two arcs) rather than a hundred elements.
 */
const HERO_ART = (() => {
  const paths: Record<string, string> = {};
  for (let row = 0; row < 7; row++) {
    const count = 9 + row * 2;
    const radius = 46 + row * 12;
    for (let i = 0; i < count; i++) {
      const angle = Math.PI * (0.12 + (0.76 * i) / (count - 1));
      const x = (160 - radius * Math.cos(angle)).toFixed(1);
      const y = (18 + radius * Math.sin(angle)).toFixed(1);
      const look =
        row === 2 && (i === 6 || i === 7)
          ? 'fill-accent stroke-ink motion-safe:animate-pulse'
          : (row * 31 + i * 17) % 6 === 0
            ? 'fill-seat-off'
            : ['fill-tier-0', 'fill-tier-1', 'fill-tier-2', 'fill-tier-3'][Math.min(3, Math.floor(row / 2))]!;
      paths[look] = `${paths[look] ?? ''}M${x} ${y}m-3.6 0a3.6 3.6 0 1 0 7.2 0a3.6 3.6 0 1 0 -7.2 0`;
    }
  }
  return Object.entries(paths);
})();

function HeroSeatArt() {
  return (
    <svg viewBox="0 0 320 120" aria-hidden className="w-full drop-shadow-sm">
      <rect x="120" y="4" width="80" height="12" rx="4" className="fill-ink" />
      {HERO_ART.map(([look, d]) => (
        <path key={look} d={d} className={look} strokeWidth={look.includes('stroke') ? 1.2 : 0} />
      ))}
    </svg>
  );
}

function Stats() {
  const stats = useStats();
  const tiles = [
    { label: 'Tickets sold', value: stats.data?.ticketsSold },
    { label: 'Events on sale', value: stats.data?.eventsOnSale },
    { label: 'Seats on hold right now', value: stats.data?.activeHolds },
  ];
  return (
    <dl className="grid grid-cols-3 divide-x divide-dashed divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex flex-col gap-1 p-3 sm:p-5">
          <dt className="order-2 text-xs text-muted sm:text-sm">{tile.label}</dt>
          <dd className="order-1 font-display text-2xl font-bold text-ink tabular-nums sm:text-4xl">
            {tile.value !== undefined ? formatNumber(tile.value) : stats.isError ? '–' : <Skeleton className="h-8 w-16 sm:h-10" />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Hero() {
  const { user, demo } = useAuth();
  const toast = useToast();
  const [signingIn, setSigningIn] = useState(false);

  const tryDemo = async () => {
    setSigningIn(true);
    try {
      const me = await demo();
      toast.push({ tone: 'success', title: `Signed in as ${me.name}`, body: 'Pick any event below and grab some seats.' });
    } catch (error) {
      toast.push({ tone: 'danger', title: 'Could not start the demo', body: errorMessage(error) });
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <section className="grid items-center gap-8 lg:grid-cols-[1.1fr_1fr]">
      <div className="flex flex-col items-start gap-5">
        <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold tracking-widest text-muted uppercase">
          <span aria-hidden className="size-2 rounded-full bg-success motion-safe:animate-pulse" /> Live box office
        </p>
        <h1 className="font-display text-5xl leading-[0.95] font-bold tracking-tight text-balance text-ink sm:text-6xl">
          Every seat sells <span className="text-accent">exactly once.</span>
        </h1>
        <p className="max-w-xl text-lg text-muted">
          Pick exact seats on a live map while everyone else does the same. Seatlock holds them while you pay, runs a fair
          waiting room for flash sales, and never sells a seat twice.
        </p>
        <div className="flex flex-wrap gap-3">
          {user ? (
            <a href="#events" className={buttonClass('primary', 'lg')}>
              Pick your seats <ArrowRight aria-hidden className="size-4" />
            </a>
          ) : (
            <Button size="lg" loading={signingIn} onClick={() => void tryDemo()}>
              <Sparkles aria-hidden className="size-4" /> Try the demo
            </Button>
          )}
          <Link to="/lab" className={buttonClass('secondary', 'lg')}>
            How it stays correct
          </Link>
        </div>
      </div>
      <div className="rounded-3xl border border-line bg-surface p-5 shadow-sm sm:p-8">
        <HeroSeatArt />
        <p className="mt-3 text-center text-xs text-muted">Seats change colour the moment someone else takes them.</p>
      </div>
    </section>
  );
}

function Events() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('category');
  const category = isCategory(raw) ? raw : null;
  const events = useEvents(category);

  const choose = (next: Category | null) => setParams(next ? { category: next } : {}, { replace: true, preventScrollReset: true });

  return (
    <section id="events" aria-labelledby="events-heading" className="flex scroll-mt-24 flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="events-heading" className="font-display text-3xl font-bold tracking-tight text-ink">
          Upcoming events
        </h2>
        <div role="group" aria-label="Filter by category" className="-mx-1 flex gap-1 overflow-x-auto px-1">
          {[null, ...EVENT_CATEGORIES].map((c) => (
            <button
              key={c ?? 'all'}
              type="button"
              aria-pressed={category === c}
              onClick={() => choose(c)}
              className={cx(
                'rounded-full border px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
                category === c ? 'border-ink bg-ink text-bg' : 'border-line bg-surface text-muted hover:text-ink',
              )}
            >
              {c ? CATEGORY_LABELS[c] : 'All'}
            </button>
          ))}
        </div>
      </div>

      {events.isPending ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <span role="status" className="sr-only">
            Loading events
          </span>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-96 rounded-2xl" />
          ))}
        </div>
      ) : events.isLoadingError ? (
        <LoadError error={events.error} onRetry={() => void events.refetch()} title="Could not load events" />
      ) : events.data.length === 0 ? (
        <EmptyState
          icon={<CalendarSearch aria-hidden />}
          title={category ? `No ${CATEGORY_LABELS[category].toLowerCase()} events right now` : 'No events on sale right now'}
          body="New shows are added all the time. Check back soon."
          action={
            category && (
              <Button variant="secondary" onClick={() => choose(null)}>
                Show all events
              </Button>
            )
          }
        />
      ) : (
        <ul aria-label="Events" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {events.data.map((event) => (
            <li key={event.id}>
              <EventCard event={event} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function Home() {
  return (
    <div className="flex flex-col gap-12">
      <Hero />
      <Stats />
      <Events />
    </div>
  );
}
