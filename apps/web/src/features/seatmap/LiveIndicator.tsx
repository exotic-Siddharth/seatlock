import type { SeatTuple } from '@seatlock/shared';
import { cx } from '../../components/ui';
import type { StreamStatus } from '../../hooks/useEventStream';
import { formatNumber } from '../../lib/format';

export type StatusCounts = Record<SeatTuple[5], number>;

export function countByStatus(seats: SeatTuple[]): StatusCounts {
  const counts = { A: 0, H: 0, S: 0 };
  for (const seat of seats) counts[seat[5]]++;
  return counts;
}

/** Whether the map is receiving live updates, and the seat counts it shows. */
export function LiveIndicator({ status, counts }: { status: StreamStatus; counts: StatusCounts }) {
  const live = status === 'live';
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <span className={cx('inline-flex items-center gap-1.5 font-medium', live ? 'text-success' : 'text-warning')}>
        <span aria-hidden className="relative flex size-2.5">
          {live && <span className="absolute inline-flex size-full rounded-full bg-success opacity-75 motion-safe:animate-ping" />}
          <span className={cx('relative inline-flex size-2.5 rounded-full', live ? 'bg-success' : 'bg-warning')} />
        </span>
        {live ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
      </span>
      <span className="tabular-nums">
        {formatNumber(counts.A)} available · {formatNumber(counts.H)} held · {formatNumber(counts.S)} sold
      </span>
    </p>
  );
}
