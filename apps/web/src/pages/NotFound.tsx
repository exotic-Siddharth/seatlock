import { Link } from 'react-router';
import { buttonClass } from '../components/ui';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-6 py-12 text-center">
      <div aria-hidden className="flex -rotate-3 rounded-2xl border border-line bg-surface shadow-md">
        <div className="flex flex-col items-start gap-1 px-6 py-5">
          <span className="text-[0.65rem] font-bold tracking-[0.3em] text-accent uppercase">No such seat</span>
          <span className="font-display text-7xl leading-none font-bold text-ink">404</span>
          <span className="text-xs text-muted">Sec ? · Row ? · Seat ?</span>
        </div>
        <div className="w-0 border-l-2 border-dashed border-line" />
        <div className="flex w-16 items-center justify-center">
          <span className="-rotate-90 text-xs font-semibold tracking-widest whitespace-nowrap text-muted uppercase">Void</span>
        </div>
      </div>
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Page not found</h1>
        <p className="mt-2 text-muted">This page doesn't exist. It may have moved, or the link has a typo.</p>
      </div>
      <Link to="/" className={buttonClass('primary')}>
        Back to events
      </Link>
    </div>
  );
}
