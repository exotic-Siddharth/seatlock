import { formatInr, type SeatTuple, type VenueLayout } from '@seatlock/shared';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, cx } from '../../components/ui';

/**
 * The picked seats, their total and the main action. A card beside the map on wide screens;
 * on phones it docks to the bottom of the screen once a seat is picked.
 */
export function SelectionPanel({
  layout,
  picked,
  tierPrices,
  max,
  onRemove,
  action,
}: {
  layout: VenueLayout;
  picked: SeatTuple[];
  tierPrices: Record<string, number>;
  max: number;
  onRemove(id: number): void;
  action: ReactNode;
}) {
  const sectionName = (key: string) => layout.sections.find((s) => s.key === key)?.name ?? key;
  const total = picked.reduce((sum, seat) => sum + (tierPrices[seat[4]] ?? 0), 0);
  const docked = picked.length > 0;

  return (
    <Card
      aria-label="Your seats"
      role="region"
      className={cx(
        'flex flex-col gap-3 p-4',
        docked &&
          'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-20 max-lg:gap-2 max-lg:rounded-none max-lg:border-x-0 max-lg:p-3 max-lg:shadow-[0_-8px_24px_rgb(0_0_0/0.12)]',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-ink">Your seats</h2>
        <span className="text-sm text-muted tabular-nums">
          {picked.length} of {max}
        </span>
      </div>

      {picked.length === 0 ? (
        <p className="text-sm text-muted">
          Pick up to {max} {max === 1 ? 'seat' : 'seats'} on the map. Seats are held for you for a few minutes while you pay.
        </p>
      ) : (
        <ul className="flex gap-2 max-lg:overflow-x-auto max-lg:pb-1 lg:flex-wrap">
          {picked.map((seat) => (
            <li
              key={seat[0]}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-2.5 text-sm"
            >
              <span className="font-semibold text-ink">
                {seat[2]}
                {seat[3]}
              </span>
              <span className="text-xs text-muted">{sectionName(seat[1])}</span>
              <button
                type="button"
                onClick={() => onRemove(seat[0])}
                aria-label={`Remove seat ${seat[2]}${seat[3]}`}
                className="rounded p-0.5 text-muted hover:bg-surface hover:text-ink"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* On phones the total sits beside the button, to keep the docked bar short. */}
      <div className="flex items-center gap-4 border-t border-dashed border-line pt-3 lg:flex-col lg:items-stretch lg:gap-3">
        {picked.length > 0 && (
          <div className="flex shrink-0 flex-col lg:flex-row lg:items-baseline lg:justify-between">
            <span className="text-sm text-muted">Total</span>
            <span className="font-display text-xl font-bold text-ink tabular-nums">{formatInr(total)}</span>
          </div>
        )}
        <div className="min-w-0 flex-1">{action}</div>
      </div>
    </Card>
  );
}
