import type { AdminEventRow, EventStatus } from '@seatlock/shared';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, ScanLine } from 'lucide-react';
import { Link } from 'react-router';
import { Badge, Button, Card, EmptyState, Skeleton, buttonClass, type BadgeTone } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, formatInr, formatNumber } from '../../lib/format';

const STATUS: Record<EventStatus, { label: string; tone: BadgeTone }> = {
  upcoming: { label: 'Upcoming', tone: 'info' },
  on_sale: { label: 'On sale', tone: 'success' },
  sold_out: { label: 'Sold out', tone: 'warning' },
  ended: { label: 'Ended', tone: 'neutral' },
};

const HEAD = 'px-4 py-3 text-left text-xs font-semibold tracking-wide text-muted uppercase';

export default function AdminEvents() {
  const events = useQuery({
    queryKey: ['admin', 'events'],
    queryFn: () => api<{ items: AdminEventRow[] }>('/api/admin/events'),
    select: (data) => data.items,
  });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">Events</h1>
          <p className="mt-1 text-muted">Everything on the box office, listed or not.</p>
        </div>
        <div className="flex gap-2">
          <Link to="/admin/checkin" className={buttonClass('secondary')}>
            <ScanLine aria-hidden className="size-4" /> Door check-in
          </Link>
          <Link to="/admin/events/new" className={buttonClass('primary')}>
            <CalendarPlus aria-hidden className="size-4" /> New event
          </Link>
        </div>
      </div>

      <div className="mt-8">
        {events.isPending && <Skeleton className="h-64 w-full" />}
        {events.isError && (
          <EmptyState
            title="Could not load events"
            body={errorMessage(events.error)}
            action={<Button onClick={() => void events.refetch()}>Try again</Button>}
          />
        )}
        {events.isSuccess && events.data.length === 0 && (
          <EmptyState
            title="No events yet"
            body="Create the first one and its seats are generated from the venue layout."
            action={
              <Link to="/admin/events/new" className={buttonClass('primary')}>
                New event
              </Link>
            }
          />
        )}
        {events.isSuccess && events.data.length > 0 && (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <caption className="sr-only">All events</caption>
              <thead className="border-b border-line">
                <tr>
                  <th scope="col" className={HEAD}>Event</th>
                  <th scope="col" className={HEAD}>Starts</th>
                  <th scope="col" className={HEAD}>Status</th>
                  <th scope="col" className={`${HEAD} text-right`}>Sold</th>
                  <th scope="col" className={`${HEAD} text-right`}>Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {events.data.map((event) => {
                  const status = STATUS[event.status];
                  return (
                    <tr key={event.id} className="hover:bg-surface-2/60">
                      <th scope="row" className="px-4 py-3 text-left font-medium">
                        <Link to={`/admin/events/${event.id}`} className="text-ink hover:text-accent hover:underline">
                          {event.title}
                        </Link>
                        <span className="block text-xs font-normal text-muted">
                          {event.venue.name}, {event.venue.city}
                        </span>
                      </th>
                      <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(event.startsAt)}</td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap gap-1">
                          <Badge tone={status.tone}>{status.label}</Badge>
                          {!event.listed && <Badge>Unlisted</Badge>}
                          {event.queueEnabled && <Badge tone="accent">Waiting room</Badge>}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatNumber(event.soldCount)} / {formatNumber(event.counts.total)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatInr(event.revenuePaise)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}
