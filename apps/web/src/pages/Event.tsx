import type { EventDetail, QueueStatus } from '@seatlock/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CircleCheck, Clock, Hourglass, MapPin, Ticket, Users } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Poster } from '../components/layout/Poster';
import { Badge, Button, Card, Skeleton, buttonClass, cx, useToast } from '../components/ui';
import { useHoldSeats } from '../features/checkout/queries';
import { Countdown } from '../features/events/Countdown';
import { EventStatusBadge } from '../features/events/EventCard';
import { LoadError } from '../features/events/LoadError';
import { Notice } from '../features/events/Notice';
import { eventKeys, useEventDetail } from '../features/events/queries';
import { LiveIndicator, countByStatus, type StatusCounts } from '../features/seatmap/LiveIndicator';
import { SeatMap } from '../features/seatmap/SeatMap';
import { SelectionPanel } from '../features/seatmap/SelectionPanel';
import { TierLegend } from '../features/seatmap/TierLegend';
import { useFlash } from '../features/seatmap/useFlash';
import { useSeatSelection } from '../features/seatmap/useSeatSelection';
import { WaitingRoom } from '../features/waiting-room/WaitingRoom';
import { queueKey, queueToken, useJoinQueue, useQueueStatus } from '../features/waiting-room/queue';
import { useEventStream } from '../hooks/useEventStream';
import { seatsQueryKey, useSeatSnapshot } from '../hooks/useSeatSnapshot';
import { ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, formatInr, formatTime } from '../lib/format';
import { createServerClock, type ServerClock } from '../lib/serverClock';

const NO_SEATS: ReadonlySet<number> = new Set();

export default function EventPage() {
  const { slug = '' } = useParams();
  const detail = useEventDetail(slug);

  if (detail.isPending) return <EventSkeleton />;
  if (detail.isError) {
    return (
      <LoadError
        error={detail.error}
        onRetry={() => void detail.refetch()}
        title="Could not load this event"
        notFoundTitle="Event not found"
        notFoundBody="It may have been removed, or the link has a typo."
      />
    );
  }
  return <EventView event={detail.data} receivedAt={detail.dataUpdatedAt} />;
}

function EventView({ event, receivedAt }: { event: EventDetail; receivedAt: number }) {
  const clock = useMemo(() => createServerClock(event.serverTime, receivedAt), [event.serverTime, receivedAt]);
  return (
    <div className="flex flex-col gap-8">
      <EventHeader event={event} />
      <SeatsOrWaitingRoom event={event} clock={clock} />
    </div>
  );
}

function EventHeader({ event }: { event: EventDetail }) {
  return (
    <header className="grid gap-6 md:grid-cols-[minmax(0,20rem)_1fr] md:items-center">
      <Poster title={event.title} hue={event.posterHue} category={event.category} />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <EventStatusBadge event={event} />
          {event.queueEnabled && (
            <Badge tone="accent">
              <Users aria-hidden className="size-3" /> Waiting room
            </Badge>
          )}
        </div>
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight text-balance text-ink sm:text-5xl">{event.title}</h1>
          {event.subtitle && <p className="mt-2 text-lg text-muted">{event.subtitle}</p>}
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Fact icon={<CalendarDays aria-hidden />} term="When">
            {formatDate(event.startsAt)} · {formatTime(event.startsAt)}
          </Fact>
          <Fact icon={<MapPin aria-hidden />} term="Where">
            {event.venue.name}, {event.venue.city}
          </Fact>
          <Fact icon={<Ticket aria-hidden />} term="Price">
            From {formatInr(event.priceFromPaise)}
          </Fact>
          <Fact icon={<Clock aria-hidden />} term="Holds">
            Up to {event.maxSeatsPerOrder} seats, held for {Math.round(event.holdTtlSeconds / 60)} min while you pay
          </Fact>
        </dl>
        {event.description && <p className="max-w-prose text-muted">{event.description}</p>}
      </div>
    </header>
  );
}

function Fact({ icon, term, children }: { icon: ReactNode; term: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-ink [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-accent">
      {icon}
      <dt className="sr-only">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Queue events show the waiting room until the visitor is admitted; everything else goes straight to the map. */
function SeatsOrWaitingRoom({ event, clock }: { event: EventDetail; clock: ServerClock }) {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const queued = event.queueEnabled && (event.status === 'on_sale' || event.status === 'upcoming');
  const queue = useQueueStatus(event.id, queued && user !== null);
  const join = useJoinQueue(event.id);
  const refreshEvent = () => void queryClient.invalidateQueries({ queryKey: eventKeys.detail(event.slug) });

  if (!queued) return <SeatPicker event={event} clock={clock} />;
  if (!user) return <WaitingRoom eventId={event.id} queue={null} saleOpensAt={event.saleOpensAt} clock={clock} onRefresh={refreshEvent} />;
  if (queue.isPending) return <MapSkeleton label="Checking your place in line" />;
  if (queue.isError) return <LoadError error={queue.error} onRetry={() => void queue.refetch()} title="Could not reach the waiting room" />;

  const status = queue.data;
  if (status.state === 'not_required' || status.state === 'admitted') {
    return <SeatPicker event={event} clock={clock} access={status.state === 'admitted' ? status : undefined} />;
  }
  return (
    <WaitingRoom
      eventId={event.id}
      queue={status}
      saleOpensAt={event.saleOpensAt}
      clock={clock}
      joining={join.isPending}
      onJoin={() =>
        join.mutate(undefined, {
          onError: (error) => toast.push({ tone: 'danger', title: 'Could not join the line', body: errorMessage(error) }),
        })
      }
      onRefresh={() => {
        void queue.refetch();
        refreshEvent();
      }}
    />
  );
}

function SeatPicker({ event, clock, access }: { event: EventDetail; clock: ServerClock; access?: QueueStatus }) {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const snapshot = useSeatSnapshot(event.id);
  const stream = useEventStream(event.id);
  const holdSeats = useHoldSeats(event.id);
  const seats = snapshot.data?.seats;
  const selection = useSeatSelection({ max: event.maxSeatsPerOrder, seats, paused: holdSeats.isPending });
  const [flashIds, flash] = useFlash();

  // Counted from the same live snapshot the map draws, so the numbers always match the seats.
  const counts = useMemo(() => countByStatus(seats ?? []), [seats]);
  const picked = useMemo(() => (seats ?? []).filter((s) => selection.selected.has(s[0])), [seats, selection.selected]);
  const myHold = snapshot.data?.myHold ?? null;
  const mine = useMemo(() => {
    if (!myHold || !seats) return NO_SEATS;
    const ids = new Set(myHold.seatIds);
    return new Set(seats.filter((s) => ids.has(s[0]) && s[5] === 'H').map((s) => s[0]));
  }, [myHold, seats]);

  if (snapshot.isPending) return <MapSkeleton label="Loading the seat map" />;
  if (snapshot.isError) {
    return <LoadError error={snapshot.error} onRetry={() => void snapshot.refetch()} title="Could not load the seat map" />;
  }

  const allSeats = snapshot.data.seats;
  const onSale = event.status === 'on_sale';
  const refreshSeats = () => void queryClient.invalidateQueries({ queryKey: seatsQueryKey(event.id) });
  const endAccess = () => {
    queueToken.clear(event.id);
    void queryClient.invalidateQueries({ queryKey: queueKey(event.id) });
  };

  const onToggle = (id: number) => {
    if (onSale) return selection.toggle(id);
    toast.push(
      event.status === 'upcoming'
        ? { tone: 'info', title: 'The sale has not opened yet', body: `Seats go on sale ${formatDateTime(event.saleOpensAt)}.` }
        : { tone: 'info', title: 'Seats are no longer on sale' },
    );
  };

  const onHoldError = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : null;
    if (code === 'SEATS_UNAVAILABLE') {
      const taken = ((error as ApiError).details as { takenSeatIds?: number[] } | undefined)?.takenSeatIds ?? [];
      selection.remove(taken);
      flash(taken);
      refreshSeats();
      const n = taken.length;
      toast.push({
        tone: 'warning',
        title: n === 0 ? 'Those seats were just taken' : `${n} of your seats ${n === 1 ? 'was' : 'were'} just taken`,
        body: 'They are flashing on the map. Pick others and try again.',
      });
    } else if (code === 'QUEUE_REQUIRED' || code === 'QUEUE_TOKEN_INVALID') {
      endAccess();
      toast.push({ tone: 'warning', title: 'Your access window has ended', body: 'Rejoin the line to pick seats.' });
    } else if (code === 'CHECKOUT_IN_PROGRESS') {
      refreshSeats();
      toast.push({ tone: 'warning', title: 'You are already paying for seats here', body: 'Finish or release that checkout first.' });
    } else if (code === 'SALE_NOT_OPEN' || code === 'SALE_CLOSED') {
      void queryClient.invalidateQueries({ queryKey: eventKeys.detail(event.slug) });
      toast.push({ tone: 'info', title: errorMessage(error) });
    } else {
      toast.push({ tone: 'danger', title: 'Could not hold seats', body: errorMessage(error) });
    }
  };

  const hold = () =>
    holdSeats.mutate([...selection.selected], {
      onSuccess: ({ hold: created }) => {
        selection.clear();
        navigate(`/checkout/${created.id}`);
      },
      onError: onHoldError,
    });

  const action = !user ? (
    <Link to={`/login?next=${encodeURIComponent(location.pathname)}`} className={buttonClass('primary', 'lg', 'w-full')}>
      Log in to hold seats
    </Link>
  ) : !onSale ? (
    <Button size="lg" disabled className="w-full">
      {event.status === 'upcoming' ? 'Sale not open yet' : event.status === 'ended' ? 'Sales have ended' : 'No seats left'}
    </Button>
  ) : (
    <Button size="lg" className="w-full" disabled={picked.length === 0} loading={holdSeats.isPending} onClick={hold}>
      {picked.length === 0 ? 'Pick seats to continue' : `Hold ${picked.length} ${picked.length === 1 ? 'seat' : 'seats'}`}
    </Button>
  );

  return (
    <section
      aria-labelledby="seats-heading"
      className={cx('grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]', picked.length > 0 && 'max-lg:pb-64')}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h2 id="seats-heading" className="font-display text-2xl font-semibold text-ink">
            Pick your seats
          </h2>
          <LiveIndicator status={stream} counts={counts} />
        </div>

        {access && (
          <Notice tone="success" icon={<CircleCheck aria-hidden />} title="You're in. Pick your seats now.">
            {access.tokenExpiresAt && (
              <>
                Your access window closes in{' '}
                <Countdown
                  target={access.tokenExpiresAt}
                  clock={clock}
                  label="Time left in your access window"
                  onDone={endAccess}
                  className="font-semibold text-ink"
                />
                .
              </>
            )}
          </Notice>
        )}
        {myHold && (
          <Notice
            tone="accent"
            icon={<Hourglass aria-hidden />}
            title={`You're holding ${myHold.seatIds.length} ${myHold.seatIds.length === 1 ? 'seat' : 'seats'}`}
            action={
              <Link to={`/checkout/${myHold.id}`} className={buttonClass('primary', 'sm')}>
                Continue to checkout
              </Link>
            }
          >
            <Countdown target={myHold.expiresAt} clock={clock} label="Time left on your hold" onDone={refreshSeats} className="font-semibold text-ink" />{' '}
            left to pay. Holding new seats releases these.
          </Notice>
        )}
        <SaleNotice event={event} clock={clock} counts={counts} />

        <SeatMap
          layout={event.layout}
          seats={allSeats}
          selected={selection.selected}
          mine={mine}
          tierPrices={event.tierPrices}
          onToggle={onToggle}
          flashIds={flashIds}
        />
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
        <Card className="p-4">
          <h2 className="mb-3 font-display text-lg font-semibold text-ink">Prices</h2>
          <TierLegend layout={event.layout} tierPrices={event.tierPrices} seats={allSeats} />
        </Card>
        <SelectionPanel
          layout={event.layout}
          picked={picked}
          tierPrices={event.tierPrices}
          max={event.maxSeatsPerOrder}
          onRemove={(id) => selection.remove([id])}
          action={action}
        />
      </aside>
    </section>
  );
}

function SaleNotice({ event, clock, counts }: { event: EventDetail; clock: ServerClock; counts: StatusCounts }) {
  const queryClient = useQueryClient();
  if (event.status === 'upcoming') {
    return (
      <Notice tone="info" icon={<Clock aria-hidden />} title="Have a look around: the sale opens soon">
        Seats go on sale in{' '}
        <Countdown
          target={event.saleOpensAt}
          clock={clock}
          label="Time until the sale opens"
          onDone={() => void queryClient.invalidateQueries({ queryKey: eventKeys.detail(event.slug) })}
          className="font-semibold text-ink"
        />
        , at {formatDateTime(event.saleOpensAt)}.
      </Notice>
    );
  }
  if (event.status === 'ended') return <Notice tone="neutral" icon={<CalendarDays aria-hidden />} title="This event has ended" />;
  if (counts.A > 0) return null;
  return counts.H > 0 ? (
    <Notice tone="warning" icon={<Hourglass aria-hidden />} title="Every seat is held right now">
      Seats come back if their checkout isn't finished. Keep this page open: the map updates live.
    </Notice>
  ) : (
    <Notice tone="neutral" icon={<Ticket aria-hidden />} title="This show is sold out">
      Every seat has found its fan.
    </Notice>
  );
}

function MapSkeleton({ label }: { label: string }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <span role="status" className="sr-only">
        {label}
      </span>
      <Skeleton className="h-[26rem] w-full rounded-2xl" />
      <div className="hidden flex-col gap-4 lg:flex">
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    </div>
  );
}

function EventSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-6 md:grid-cols-[minmax(0,20rem)_1fr] md:items-center">
        <Skeleton className="aspect-[4/3] rounded-2xl" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-12 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
      <MapSkeleton label="Loading event" />
    </div>
  );
}
