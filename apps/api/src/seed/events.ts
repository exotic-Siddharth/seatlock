import type { Category } from '@seatlock/shared';

/**
 * The events of the dev seed. Every name, act and description is invented. Times are relative to
 * the moment of seeding: 5 events on sale, one opening in 3 minutes behind the waiting room, and one
 * whose sale opens in 2 days.
 */
export type SeedEvent = {
  title: string;
  subtitle: string;
  description: string;
  category: Category;
  venueSlug: string;
  posterHue: number;
  /** Minutes from now until the sale opens (negative: it already has). */
  saleOpensInMin: number;
  startsInDays: number;
  /** Paise per layout tier. */
  tierPrices: Record<string, number>;
  queueEnabled: boolean;
  admitRatePerSec?: number;
};

const ARENA_PRICES = { platinum: 799_900, gold: 599_900, silver: 399_900, bronze: 199_900 };
const HALL_PRICES = { gold: 349_900, silver: 249_900, balcony: 149_900 };

const DAY = 24 * 60;

export const SEED_EVENTS: SeedEvent[] = [
  {
    title: 'Monsoon Static',
    subtitle: 'Wet Neon, live in full',
    description:
      'Monsoon Static play slow-burning drums under rain-soaked synths, and this is their first night on an arena stage. The set is built around their cult record Wet Neon, with a full light rig that follows the weather the songs describe. Doors open at six and the support act starts at seven.',
    category: 'music',
    venueSlug: 'riverside-arena',
    posterHue: 275,
    saleOpensInMin: -3 * DAY,
    startsInDays: 21,
    tierPrices: ARENA_PRICES,
    queueEnabled: false,
  },
  {
    title: 'Night Ragas with the Lantern Orchestra',
    subtitle: 'Twelve strings, one long evening',
    description:
      'The Lantern Orchestra tune twelve string instruments to the ragas of the late hours and play them without a break. Expect slow openings, a long middle and a finish that most of the hall hums along to. Seating is unreserved by row, so the front of the stalls fills first.',
    category: 'music',
    venueSlug: 'lotus-hall',
    posterHue: 28,
    saleOpensInMin: -5 * DAY,
    startsInDays: 12,
    tierPrices: HALL_PRICES,
    queueEnabled: false,
  },
  {
    title: 'Chai & Chaos',
    subtitle: 'Six comics, one tiny stage',
    description:
      'Six working comics get ten minutes each to prove that a basement is the best place to hear a joke land. The room holds barely a hundred people, so every punchline has a face attached. The host promises at least one heckle that goes better than the act.',
    category: 'comedy',
    venueSlug: 'basement-nine',
    posterHue: 330,
    saleOpensInMin: -4 * DAY,
    startsInDays: 6,
    tierPrices: { front: 99_900, back: 69_900 },
    queueEnabled: false,
  },
  {
    title: 'Paper Boats',
    subtitle: 'A play in two acts',
    description:
      'Two neighbours fold paper boats from the same unpaid bills and race them down the monsoon gutter outside their building. What begins as a joke turns into a quiet argument about what each of them owes the other. The production runs two hours with one interval.',
    category: 'theatre',
    venueSlug: 'lotus-hall',
    posterHue: 200,
    saleOpensInMin: -2 * DAY,
    startsInDays: 18,
    tierPrices: HALL_PRICES,
    queueEnabled: false,
  },
  {
    title: 'Kabaddi Kings Cup Final',
    subtitle: 'Deccan Thunder v Konkan Sharks',
    description:
      'The two best raiding sides of the season meet for the cup in a single match under floodlights. Deccan Thunder have not lost at home all year, and the Konkan Sharks have not conceded a late point in six. The arena sells out for finals, so book early.',
    category: 'sports',
    venueSlug: 'riverside-arena',
    posterHue: 140,
    saleOpensInMin: -DAY,
    startsInDays: 30,
    tierPrices: { platinum: 499_900, gold: 349_900, silver: 249_900, bronze: 149_900 },
    queueEnabled: false,
  },
  {
    title: 'Neon Bazaar Live',
    subtitle: 'Flash sale with a waiting room',
    description:
      'Neon Bazaar turn a night market of sounds into a two-hour show: street recordings, brass hooks and a very loud bass drum. Tickets are scarce, so the sale opens through a waiting room. Join early and you get a random place in line when the sale starts; everyone after that queues in order.',
    category: 'music',
    venueSlug: 'riverside-arena',
    posterHue: 310,
    saleOpensInMin: 3,
    startsInDays: 14,
    tierPrices: ARENA_PRICES,
    queueEnabled: true,
    admitRatePerSec: 5,
  },
  {
    title: 'Slow Cities',
    subtitle: 'On walking, maps and getting lost',
    description:
      'A cartographer and a city planner walk the audience through why some neighbourhoods feel short and others feel endless. They bring hand-drawn maps, a stopwatch and a few strong opinions about pavements. Questions from the floor take the second half of the evening.',
    category: 'talk',
    venueSlug: 'lotus-hall',
    posterHue: 90,
    saleOpensInMin: 2 * DAY,
    startsInDays: 40,
    tierPrices: HALL_PRICES,
    queueEnabled: false,
  },
];
