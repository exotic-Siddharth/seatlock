import { cx } from './cx';

/** A pulsing placeholder; size it with `className`, e.g. "h-4 w-32". */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-md bg-surface-2', className)} />;
}
