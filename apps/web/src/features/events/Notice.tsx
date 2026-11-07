import type { ReactNode } from 'react';
import { cx } from '../../components/ui';

const NOTICE_TONES = {
  info: 'border-info/30 bg-info/8 [&>svg]:text-info',
  success: 'border-success/30 bg-success/8 [&>svg]:text-success',
  warning: 'border-warning/30 bg-warning/8 [&>svg]:text-warning',
  accent: 'border-accent/30 bg-accent/8 [&>svg]:text-accent',
  neutral: 'border-line bg-surface-2 [&>svg]:text-muted',
};

/** A one-line status banner with an icon, an optional detail line and an optional action. */
export function Notice({
  tone,
  icon,
  title,
  children,
  action,
}: {
  tone: keyof typeof NOTICE_TONES;
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={cx('flex flex-wrap items-start gap-3 rounded-xl border p-4 [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0', NOTICE_TONES[tone])}>
      {icon}
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-ink">{title}</p>
        {children && <p className="text-sm text-muted">{children}</p>}
      </div>
      {action}
    </div>
  );
}
