import type { QueueStatus } from '@seatlock/shared';
import { Clock, Gauge, RefreshCw, Shuffle, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Button, Card, buttonClass } from '../../components/ui';
import { formatNumber, formatTime } from '../../lib/format';
import type { ServerClock } from '../../lib/serverClock';
import { Countdown } from '../events/Countdown';
import { startingAhead } from './queue';

export const LOTTERY_NOTE = 'Everyone who joins before the sale opens gets a random place when it opens.';

function waitText(seconds: number | null): string {
  if (seconds === null) return 'Working out your wait';
  if (seconds < 60) return 'Less than a minute to go';
  return `About ${Math.ceil(seconds / 60)} min to go`;
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-sm text-muted [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <span>{children}</span>
    </li>
  );
}

function Progress({ eventId, queue }: { eventId: string; queue: QueueStatus }) {
  const ahead = queue.aheadCount;
  const start = ahead === null ? null : startingAhead(eventId, ahead);
  const percent = ahead === null || !start ? 0 : Math.round(((start - ahead) / start) * 100);
  return (
    <div
      role="progressbar"
      aria-label="Your progress through the line"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-3 overflow-hidden rounded-full bg-surface-2"
    >
      <div
        className="h-full rounded-full bg-[repeating-linear-gradient(-45deg,var(--accent)_0_10px,var(--accent-strong)_10px_20px)] transition-[width] duration-700 motion-reduce:transition-none"
        style={{ width: `${Math.max(percent, 3)}%` }}
      />
    </div>
  );
}

export type WaitingRoomProps = {
  eventId: string;
  /** null for a guest, who must log in to join. */
  queue: QueueStatus | null;
  /** Used for a guest, who has no queue status. */
  saleOpensAt: string;
  clock: ServerClock;
  /** Not needed for a guest, who gets a log-in link instead. */
  onJoin?(): void;
  joining?: boolean;
  /** Re-checks the status when a countdown it shows runs out. */
  onRefresh(): void;
};

/**
 * The flash-sale waiting room, shown instead of the seat map until the visitor is admitted:
 * the sale countdown, their place in line, progress, wait and admit rate.
 */
export function WaitingRoom({ eventId, queue, saleOpensAt, clock, onJoin, joining = false, onRefresh }: WaitingRoomProps) {
  const location = useLocation();
  const opensAt = queue?.saleOpensAt ?? saleOpensAt;
  const beforeSale = Date.parse(opensAt) > clock.now();
  const state = queue?.state ?? 'guest';

  const title = {
    guest: 'Join the waiting room',
    not_open: 'The waiting room opens soon',
    not_joined: 'Join the waiting room',
    waiting: "You're in line",
    expired: 'Your access window has ended',
    admitted: "You're in",
    not_required: "You're in",
  }[state];

  return (
    <Card className="relative overflow-hidden p-6 sm:p-10">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-1.5 bg-[repeating-linear-gradient(90deg,var(--accent)_0_14px,transparent_14px_22px)]"
      />
      <div className="mx-auto flex max-w-xl flex-col items-center gap-6 text-center">
        <p className="inline-flex items-center gap-2 rounded-full bg-accent/12 px-3 py-1 text-xs font-semibold tracking-widest text-accent uppercase">
          <Users aria-hidden className="size-3.5" /> Waiting room
        </p>
        <h2 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">{title}</h2>

        {beforeSale && (
          <div className="flex flex-col items-center gap-1">
            <p className="text-sm text-muted">The sale opens in</p>
            <Countdown
              target={opensAt}
              clock={clock}
              label="Time until the sale opens"
              onDone={onRefresh}
              className="font-display text-5xl font-bold text-ink sm:text-6xl"
            />
            <p className="text-sm text-muted">at {formatTime(opensAt)}</p>
          </div>
        )}

        {state === 'waiting' && queue && (
          <div className="flex w-full flex-col gap-4">
            {queue.position === null ? (
              <p className="text-muted">Your place is drawn when the sale opens.</p>
            ) : (
              <div>
                <p className="text-sm tracking-widest text-muted uppercase">Your place</p>
                <p className="font-display text-6xl font-bold text-accent tabular-nums sm:text-7xl">{formatNumber(queue.position)}</p>
                <p className="mt-1 text-ink">
                  {queue.aheadCount === 0 ? "You're next" : `${formatNumber(queue.aheadCount ?? 0)} people ahead of you`}
                </p>
              </div>
            )}
            <Progress eventId={eventId} queue={queue} />
            <ul className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center sm:gap-6">
              <Fact icon={<Clock aria-hidden />}>{waitText(queue.estimatedWaitSec)}</Fact>
              <Fact icon={<Gauge aria-hidden />}>Admitting {formatNumber(queue.admitRatePerSec)} people per second</Fact>
              <Fact icon={<Users aria-hidden />}>{formatNumber(queue.queueLength)} in line</Fact>
            </ul>
          </div>
        )}

        {state === 'not_open' && queue && (
          <div className="flex flex-col items-center gap-1">
            <p className="text-muted">It opens 10 minutes before the sale. Come back in</p>
            <Countdown
              target={queue.joinOpensAt}
              clock={clock}
              label="Time until the waiting room opens"
              onDone={onRefresh}
              className="font-display text-3xl font-bold text-ink"
            />
          </div>
        )}

        {(state === 'guest' || state === 'not_joined') && (
          <div className="flex flex-col items-center gap-3">
            <p className="max-w-md text-muted">
              {beforeSale
                ? 'Seats for this show sell through a waiting room, so everyone gets a fair turn.'
                : 'The sale is live. Join the line and the seat map opens by itself when it is your turn.'}
            </p>
            {queue && (
              <ul className="flex flex-col items-center gap-2 sm:flex-row sm:gap-6">
                <Fact icon={<Users aria-hidden />}>{formatNumber(queue.queueLength)} in line</Fact>
                <Fact icon={<Gauge aria-hidden />}>Admitting {formatNumber(queue.admitRatePerSec)} people per second</Fact>
              </ul>
            )}
          </div>
        )}

        {state === 'expired' && (
          <p className="text-muted">Access lasts 15 minutes. Rejoin the line to pick seats again; you go to the back.</p>
        )}

        {beforeSale && state !== 'not_open' && (
          <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-4 py-3 text-left text-sm text-ink">
            <Shuffle aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
            {LOTTERY_NOTE}
          </p>
        )}

        {state === 'guest' && (
          <Link to={`/login?next=${encodeURIComponent(location.pathname)}`} className={buttonClass('primary', 'lg')}>
            Log in to join the line
          </Link>
        )}
        {(state === 'not_joined' || state === 'expired') && (
          <Button size="lg" loading={joining} onClick={onJoin}>
            {state === 'expired' ? 'Rejoin the line' : 'Join the line'}
          </Button>
        )}

        {state === 'waiting' && (
          <p className="max-w-md text-sm text-balance text-muted">
            <RefreshCw aria-hidden className="mr-1.5 inline size-4 align-[-3px]" />
            Refreshing is safe: you keep your place. The seat map opens by itself when it's your turn.
          </p>
        )}
      </div>
    </Card>
  );
}
