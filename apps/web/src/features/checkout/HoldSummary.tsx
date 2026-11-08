import type { Hold } from '@seatlock/shared';
import { Timer } from 'lucide-react';
import { Link } from 'react-router';
import { Button, Card, cx } from '../../components/ui';
import { formatInr } from '../../lib/format';
import type { ServerClock } from '../../lib/serverClock';
import { Countdown } from '../events/Countdown';
import { tierLabel } from '../tickets/TicketStub';

/** The order summary as a ticket: hold countdown, seats, total, and a way to give the seats back. */
export function HoldSummary({
  hold,
  clock,
  urgent,
  canRelease,
  releaseHint,
  onRelease,
}: {
  hold: Hold;
  clock: ServerClock;
  /** Under a minute left. */
  urgent: boolean;
  canRelease: boolean;
  /** Why Release is unavailable right now, if it is. */
  releaseHint?: string;
  onRelease(): void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className={cx('flex items-center gap-4 p-5 text-on-accent transition-colors', urgent ? 'bg-danger' : 'bg-accent')}>
        <Timer aria-hidden className={cx('size-8 shrink-0', urgent && 'motion-safe:animate-pulse')} />
        <div>
          <p className="text-sm font-medium opacity-90">Seats held for you</p>
          <Countdown target={hold.expiresAt} clock={clock} label="Time left to pay" className="font-display text-4xl leading-none font-bold" />
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <div>
          <p className="text-xs font-semibold tracking-widest text-muted uppercase">Order summary</p>
          <Link to={`/events/${hold.eventSlug}`} className="font-display text-lg font-semibold text-ink hover:text-accent">
            {hold.eventTitle}
          </Link>
        </div>
        <ul className="flex flex-col divide-y divide-dashed divide-line">
          {hold.seats.map((seat) => (
            <li key={seat.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                <span className="block text-sm font-medium text-ink">{seat.label}</span>
                <span className="block text-xs text-muted">{tierLabel(seat.tier)}</span>
              </span>
              <span className="text-sm text-ink tabular-nums">{formatInr(seat.pricePaise)}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t-2 border-dashed border-line pt-3">
          <span className="font-medium text-ink">Total</span>
          <span className="font-display text-2xl font-bold text-ink tabular-nums">{formatInr(hold.amountPaise)}</span>
        </div>
        <div className="flex flex-col items-start gap-1">
          <Button variant="ghost" size="sm" disabled={!canRelease} onClick={onRelease} className="text-muted">
            Release seats
          </Button>
          {releaseHint && <p className="text-xs text-muted">{releaseHint}</p>}
        </div>
      </div>
    </Card>
  );
}
