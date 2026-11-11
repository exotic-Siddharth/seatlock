import { formatInr, type SeatTuple, type VenueLayout } from '@seatlock/shared';
import { useMemo } from 'react';
import { formatNumber } from '../../lib/format';

const TIER_SWATCH = ['bg-tier-0', 'bg-tier-1', 'bg-tier-2', 'bg-tier-3'];

/**
 * Price tiers with live availability, plus the key to the seat colours. It doubles as a text
 * alternative to the map: everything the colours say is written out here.
 */
export function TierLegend({ layout, tierPrices, seats }: { layout: VenueLayout; tierPrices: Record<string, number>; seats: SeatTuple[] }) {
  const counts = useMemo(() => {
    const byTier = new Map<string, { total: number; available: number }>();
    for (const seat of seats) {
      const c = byTier.get(seat[4]) ?? { total: 0, available: 0 };
      c.total++;
      if (seat[5] === 'A') c.available++;
      byTier.set(seat[4], c);
    }
    return byTier;
  }, [seats]);

  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Price tiers" className="flex flex-col gap-2">
        {layout.tiers.map((tier, i) => {
          const c = counts.get(tier.key) ?? { total: 0, available: 0 };
          return (
            <li key={tier.key} className="flex items-center gap-3">
              <span aria-hidden className={`size-3.5 shrink-0 rounded-full ${TIER_SWATCH[i % 4]}`} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-ink">{tier.name}</span>
                <span className="block text-xs text-muted">
                  {c.available === 0 ? 'None left' : `${formatNumber(c.available)} of ${formatNumber(c.total)} left`}
                </span>
              </span>
              <span className="font-display font-semibold text-ink tabular-nums">{formatInr(tierPrices[tier.key] ?? 0)}</span>
            </li>
          );
        })}
      </ul>
      <ul aria-label="Seat colours" className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs text-muted">
        <li className="flex items-center gap-2">
          <span aria-hidden className="size-3 rounded-full bg-accent ring-2 ring-ink/70" /> Your pick
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="size-3 rounded-full bg-accent/40 ring-1 ring-accent" /> Held by you
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="size-3 rounded-full bg-seat-off" /> Held by someone
        </li>
        <li className="flex items-center gap-2">
          <span
            aria-hidden
            className="size-3 rounded-full bg-seat-off bg-[repeating-linear-gradient(45deg,transparent_0_2px,var(--muted)_2px_3px)]"
          />{' '}
          Sold
        </li>
      </ul>
    </div>
  );
}
