import { cx } from './cx';

const SIZES = { sm: 'size-4', md: 'size-6', lg: 'size-10' } as const;

/** With a `label` it is announced as a status; without one it is decorative (e.g. inside a button). */
export function Spinner({ size = 'md', label, className }: { size?: keyof typeof SIZES; label?: string; className?: string }) {
  const svg = (
    <svg className={cx('animate-spin text-current', SIZES[size], className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
  if (!label) return svg;
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}
