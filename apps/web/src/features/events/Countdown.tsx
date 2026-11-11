import { useEffect, useRef } from 'react';
import { cx } from '../../components/ui';
import { useCountdown, type ServerClock } from '../../lib/serverClock';

const pad = (n: number) => String(n).padStart(2, '0');

/** "04:59" under an hour, "2:04:59" under a day, then "3d 4h". */
export function formatDuration(msLeft: number): string {
  const total = Math.ceil(msLeft / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Time left until `target` by the server clock, announced as a timer. `onDone` runs once when
 * it reaches zero (for example, to re-fetch the event when its sale opens).
 */
export function Countdown({
  target,
  clock,
  label,
  onDone,
  className,
}: {
  target: string;
  clock: ServerClock;
  /** Accessible name, e.g. "Time left to pay". */
  label: string;
  onDone?: () => void;
  className?: string;
}) {
  const { msLeft, done } = useCountdown(target, clock);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);
  useEffect(() => {
    if (done) onDoneRef.current?.();
  }, [done]);

  return (
    <span role="timer" aria-label={label} className={cx('tabular-nums', className)}>
      {formatDuration(msLeft)}
    </span>
  );
}
