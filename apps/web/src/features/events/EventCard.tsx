import type { EventStatus, EventSummary } from '@seatlock/shared';
import { CalendarDays, MapPin, Users } from 'lucide-react';
import { Link } from 'react-router';
import { Poster } from '../../components/layout/Poster';
import { Badge, type BadgeTone } from '../../components/ui';
import { formatDate, formatInr, formatTime } from '../../lib/format';

const shortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** "Selling fast" once fewer than this share of seats is left. */
const SELLING_FAST = 0.15;

function statusBadge(event: Pick<EventSummary, 'status' | 'saleOpensAt' | 'counts'>): { tone: BadgeTone; label: string } {
  const labels: Record<EventStatus, { tone: BadgeTone; label: string }> = {
    on_sale: { tone: 'success', label: 'On sale' },
    upcoming: { tone: 'info', label: `Opens ${shortDate.format(new Date(event.saleOpensAt))}` },
    sold_out: { tone: 'danger', label: 'Sold out' },
    ended: { tone: 'neutral', label: 'Ended' },
  };
  const { total, available } = event.counts;
  if (event.status === 'on_sale' && available > 0 && available / total < SELLING_FAST) return { tone: 'warning', label: 'Selling fast' };
  return labels[event.status];
}

export function EventStatusBadge({ event }: { event: Pick<EventSummary, 'status' | 'saleOpensAt' | 'counts'> }) {
  const { tone, label } = statusBadge(event);
  return <Badge tone={tone}>{label}</Badge>;
}

/** A grid card: poster art, when and where, price and availability. */
export function EventCard({ event }: { event: EventSummary }) {
  const { total, available } = event.counts;
  const soldShare = total > 0 ? (total - available) / total : 0;

  return (
    <Link
      to={`/events/${event.slug}`}
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <Poster title={event.title} hue={event.posterHue} category={event.category} size="sm" className="rounded-none" />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <EventStatusBadge event={event} />
          {event.queueEnabled && (
            <Badge tone="accent">
              <Users aria-hidden className="size-3" />
              Waiting room
            </Badge>
          )}
        </div>
        <div>
          <h3 className="font-display text-lg leading-tight font-semibold text-ink group-hover:text-accent">{event.title}</h3>
          {event.subtitle && <p className="mt-0.5 line-clamp-1 text-sm text-muted">{event.subtitle}</p>}
        </div>
        <dl className="flex flex-col gap-1 text-sm text-muted">
          <div className="flex items-center gap-2">
            <dt className="sr-only">When</dt>
            <CalendarDays aria-hidden className="size-4 shrink-0" />
            <dd>
              {formatDate(event.startsAt)} · {formatTime(event.startsAt)}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="sr-only">Where</dt>
            <MapPin aria-hidden className="size-4 shrink-0" />
            <dd>
              {event.venue.name}, {event.venue.city}
            </dd>
          </div>
        </dl>
        <div className="mt-auto flex items-end justify-between gap-3 border-t border-dashed border-line pt-3">
          <p className="text-sm text-muted">
            From <span className="font-display text-base font-bold text-ink">{formatInr(event.priceFromPaise)}</span>
          </p>
          <div className="w-24" title={`${available} of ${total} seats left`}>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(soldShare * 100)}%` }} />
            </div>
            <p className="mt-1 text-right text-xs text-muted">{available === 0 ? 'No seats left' : `${available} left`}</p>
          </div>
        </div>
      </div>
    </Link>
  );
}
