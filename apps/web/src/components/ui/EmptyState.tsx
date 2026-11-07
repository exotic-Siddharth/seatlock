import type { ReactNode } from 'react';
import { cx } from './cx';

/** A centred message for empty lists, errors and dead ends, with an optional action. */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-16 text-center', className)}>
      {icon && <div className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted [&>svg]:size-6">{icon}</div>}
      <h2 className="font-display text-xl font-semibold text-ink">{title}</h2>
      {body && <div className="text-muted">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
