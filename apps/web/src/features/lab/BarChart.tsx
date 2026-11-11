import type { StrategyName } from '@seatlock/shared';

export type Bar = { strategy: StrategyName; value: number };

/** One colour per strategy, shared by every chart; the value is always printed next to the bar as well. */
const COLOR: Record<StrategyName, string> = {
  naive: 'var(--danger)',
  pessimistic: 'var(--tier-2)',
  conditional: 'var(--tier-1)',
  redis: 'var(--tier-0)',
};

const WIDTH = 520;
const LABEL_W = 104;
const VALUE_W = 78;
const ROW_H = 34;
const BAR_H = 20;

/**
 * Horizontal bars, one per strategy, all on the same zero-based scale. The accessible name lists
 * every value; the results table next to the chart holds the same numbers.
 */
export function BarChart({ title, bars, format }: { title: string; bars: Bar[]; format: (value: number) => string }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const room = WIDTH - LABEL_W - VALUE_W;
  const summary = `${title}: ${bars.map((b) => `${b.strategy} ${format(b.value)}`).join(', ')}`;

  return (
    <figure>
      <figcaption className="mb-1 text-sm font-semibold">{title}</figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${bars.length * ROW_H + 4}`} role="img" aria-label={summary} className="h-auto w-full">
        <title>{summary}</title>
        {bars.map((bar, i) => {
          const y = i * ROW_H + 4;
          const width = Math.max(2, (bar.value / max) * room);
          return (
            <g key={bar.strategy}>
              <text x={LABEL_W - 10} y={y + BAR_H / 2 + 4.5} textAnchor="end" style={{ fill: 'var(--ink)', fontSize: 13 }}>
                {bar.strategy}
              </text>
              <rect x={LABEL_W} y={y} width={width} height={BAR_H} rx={4} style={{ fill: COLOR[bar.strategy] }} />
              <text x={LABEL_W + width + 8} y={y + BAR_H / 2 + 4.5} style={{ fill: 'var(--ink)', fontSize: 13, fontWeight: 600 }}>
                {format(bar.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
