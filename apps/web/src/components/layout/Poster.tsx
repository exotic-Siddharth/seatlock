import type { Category } from '@seatlock/shared';
import { Drama, MessagesSquare, Mic, Music, Ticket, Trophy, type LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { cx } from '../ui';

const CATEGORIES: Record<Category, { label: string; icon: LucideIcon }> = {
  music: { label: 'Music', icon: Music },
  comedy: { label: 'Comedy', icon: Mic },
  theatre: { label: 'Theatre', icon: Drama },
  sports: { label: 'Sports', icon: Trophy },
  talk: { label: 'Talk', icon: MessagesSquare },
};

const SIZES = {
  sm: { box: 'aspect-[4/3] rounded-xl', pad: 'p-3', title: 'text-lg' },
  md: { box: 'aspect-[4/3] rounded-2xl', pad: 'p-4', title: 'text-2xl sm:text-3xl' },
  lg: { box: 'aspect-[16/9] rounded-3xl sm:aspect-[21/9]', pad: 'p-6 sm:p-8', title: 'text-4xl sm:text-6xl' },
};

/** FNV-1a hash of the title: the same event always gets the same artwork. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** mulberry32: a small seeded PRNG returning [0, 1). */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v: number) => Math.round(v * 10) / 10;
const hsl = (hue: number, s: number, l: number) => `hsl(${(((hue % 360) + 360) % 360).toFixed(0)} ${s}% ${l}%)`;

export type PosterProps = {
  title: string;
  /** posterHue of the event, 0-359. */
  hue: number;
  category: Category | string;
  size?: keyof typeof SIZES;
  className?: string;
};

/** Generated event artwork: a gradient in the event's hue, seeded shapes, and the title in big type. */
export function Poster({ title, hue, category, size = 'md', className }: PosterProps) {
  const id = useId().replace(/[^\w-]/g, '');
  const rand = seededRandom(hash(title));
  const orbs = [24, -36, 60, 0].map((shift) => ({
    cx: round(rand() * 400),
    cy: round(rand() * 300),
    r: round(40 + rand() * 120),
    fill: hsl(hue + shift, 90, 68),
    opacity: round(0.15 + rand() * 0.25),
  }));
  const tilt = Math.round(rand() * 50 - 25);
  const { label, icon: Icon } = CATEGORIES[category as Category] ?? { label: category, icon: Ticket };
  const s = SIZES[size];

  return (
    <div role="img" aria-label={`${title} poster`} className={cx('relative isolate overflow-hidden text-white', s.box, className)}>
      <svg className="absolute inset-0 -z-10 size-full" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <defs>
          <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={hsl(hue, 72, 52)} />
            <stop offset="1" stopColor={hsl(hue + 40, 70, 22)} />
          </linearGradient>
          <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.45" stopColor="#000" stopOpacity="0" />
            <stop offset="1" stopColor="#000" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <rect width="400" height="300" fill={`url(#${id}-bg)`} />
        {orbs.map((orb, i) => (
          <circle key={i} cx={orb.cx} cy={orb.cy} r={orb.r} fill={orb.fill} opacity={orb.opacity} />
        ))}
        <g transform={`rotate(${tilt} 200 150)`} fill="#fff" opacity="0.1">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} x="-150" y={i * 52 - 10} width="700" height="14" />
          ))}
        </g>
        {/* the tear-off line of a ticket stub */}
        <line x1="336" y1="0" x2="336" y2="300" stroke="#fff" strokeOpacity="0.35" strokeWidth="2" strokeDasharray="2 7" />
        <rect width="400" height="300" fill={`url(#${id}-fade)`} />
      </svg>
      <div className={cx('flex h-full flex-col justify-between', s.pad)}>
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-black/25 px-2.5 py-1 text-xs font-semibold tracking-wide uppercase backdrop-blur-sm">
          <Icon aria-hidden className="size-3.5" />
          {label}
        </span>
        <p className={cx('line-clamp-3 font-display leading-[0.95] font-bold tracking-tight text-balance drop-shadow-md', s.title)}>
          {title}
        </p>
      </div>
    </div>
  );
}
