const WIDTH = 300;
const HEIGHT = 64;
const PAD = 4;

/**
 * A minimal line chart: one point per value, oldest on the left, scaled so the peak
 * touches the top. An all-zero series draws a flat line along the bottom.
 */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const peak = Math.max(1, ...values);
  const step = values.length > 1 ? (WIDTH - 2 * PAD) / (values.length - 1) : 0;
  const points = values.map((v, i) => ({
    x: PAD + i * step,
    y: HEIGHT - PAD - (v / peak) * (HEIGHT - 2 * PAD),
  }));

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const last = points.at(-1);
  const area = last && `${line} L${last.x.toFixed(1)} ${HEIGHT - PAD} L${PAD} ${HEIGHT - PAD} Z`;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label} className="h-16 w-full" preserveAspectRatio="none">
      <title>{label}</title>
      {area && <path d={area} style={{ fill: 'var(--accent)', opacity: 0.14 }} />}
      <path
        data-role="line"
        d={line}
        fill="none"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={{ stroke: 'var(--accent)' }}
      />
    </svg>
  );
}
