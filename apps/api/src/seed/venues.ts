import { SEAT_PITCH, type VenueLayout, type VenueSection } from '@seatlock/shared';
import { BENCH_LAYOUT } from '../bench/seed';

/** The venues of the dev seed. All names and places are fictional. */
export type SeedVenue = { slug: string; name: string; city: string; layout: VenueLayout };

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * A section of a fan around a stage. Row A is `innerRadius` away from `center`, on the ray at
 * `bearingDeg` (0 = straight down the page, positive = towards the right), and the rows step
 * away from the stage. Seats are laid left to right as seen from the stage.
 */
function fanSection(
  center: { x: number; y: number },
  spec: Pick<VenueSection, 'key' | 'name' | 'tier' | 'rows' | 'seatsPerRow'> & { bearingDeg: number; innerRadius: number },
): VenueSection {
  const bearing = (spec.bearingDeg * Math.PI) / 180;
  const halfWidth = ((spec.seatsPerRow - 1) * SEAT_PITCH) / 2;
  // `x`,`y` is row A seat 1: the middle of row A, moved half a row to the left along the tangent.
  const x = center.x + spec.innerRadius * Math.sin(bearing) - halfWidth * Math.cos(bearing);
  const y = center.y + spec.innerRadius * Math.cos(bearing) + halfWidth * Math.sin(bearing);
  return {
    key: spec.key,
    name: spec.name,
    tier: spec.tier,
    rows: spec.rows,
    seatsPerRow: spec.seatsPerRow,
    x: round1(x),
    y: round1(y),
    angle: round1(-spec.bearingDeg), // rotating by -bearing turns the rows to face the stage
  };
}

const ARENA_CENTER = { x: 600, y: 60 };

/*
 * Riverside Arena: 2,400 seats in 8 sections fanned around an end stage.
 *   Lower bowl, 4 sections of 16 x 15 = 240 (960 seats): platinum in the middle pair, gold on the flanks.
 *   Upper bowl, 4 sections of 24 x 15 = 360 (1,440 seats): silver in the middle pair, bronze on the flanks.
 * Checked with seatPosition over every seat (test/admin/seed.test.ts repeats the check on each run):
 *   bounding box of the seat centres is x 79.3 to 1120.7, y 110 to 628.1, inside the 1200 x 700 canvas
 *   with room for the 3.6 seat radius; seats of different sections are at least 16.3 units apart
 *   (the pitch is 10); no seat is on the stage.
 */
const RIVERSIDE_ARENA: VenueLayout = {
  width: 1200,
  height: 700,
  stage: { x: 500, y: 30, w: 200, h: 60, label: 'Stage' },
  tiers: [
    { key: 'platinum', name: 'Platinum' },
    { key: 'gold', name: 'Gold' },
    { key: 'silver', name: 'Silver' },
    { key: 'bronze', name: 'Bronze' },
  ],
  sections: [
    fanSection(ARENA_CENTER, { key: 'LA', name: 'Lower A', tier: 'gold', rows: 15, seatsPerRow: 16, bearingDeg: -60, innerRadius: 230 }),
    fanSection(ARENA_CENTER, { key: 'LB', name: 'Lower B', tier: 'platinum', rows: 15, seatsPerRow: 16, bearingDeg: -20, innerRadius: 230 }),
    fanSection(ARENA_CENTER, { key: 'LC', name: 'Lower C', tier: 'platinum', rows: 15, seatsPerRow: 16, bearingDeg: 20, innerRadius: 230 }),
    fanSection(ARENA_CENTER, { key: 'LD', name: 'Lower D', tier: 'gold', rows: 15, seatsPerRow: 16, bearingDeg: 60, innerRadius: 230 }),
    fanSection(ARENA_CENTER, { key: 'UA', name: 'Upper A', tier: 'bronze', rows: 15, seatsPerRow: 24, bearingDeg: -54, innerRadius: 420 }),
    fanSection(ARENA_CENTER, { key: 'UB', name: 'Upper B', tier: 'silver', rows: 15, seatsPerRow: 24, bearingDeg: -18, innerRadius: 420 }),
    fanSection(ARENA_CENTER, { key: 'UC', name: 'Upper C', tier: 'silver', rows: 15, seatsPerRow: 24, bearingDeg: 18, innerRadius: 420 }),
    fanSection(ARENA_CENTER, { key: 'UD', name: 'Upper D', tier: 'bronze', rows: 15, seatsPerRow: 24, bearingDeg: 54, innerRadius: 420 }),
  ],
};

/** Lotus Hall: 480 seats. Stalls (gold centre, silver sides and rear) and a balcony. */
const LOTUS_HALL: VenueLayout = {
  width: 600,
  height: 340,
  stage: { x: 150, y: 20, w: 300, h: 40, label: 'Stage' },
  tiers: [
    { key: 'gold', name: 'Gold' },
    { key: 'silver', name: 'Silver' },
    { key: 'balcony', name: 'Balcony' },
  ],
  sections: [
    { key: 'SC', name: 'Centre Stalls', tier: 'gold', rows: 8, seatsPerRow: 20, x: 205, y: 100, angle: 0 },
    { key: 'SL', name: 'Left Stalls', tier: 'silver', rows: 8, seatsPerRow: 8, x: 100, y: 100, angle: 0 },
    { key: 'SR', name: 'Right Stalls', tier: 'silver', rows: 8, seatsPerRow: 8, x: 430, y: 100, angle: 0 },
    { key: 'SX', name: 'Rear Stalls', tier: 'silver', rows: 4, seatsPerRow: 28, x: 165, y: 190, angle: 0 },
    { key: 'BK', name: 'Balcony', tier: 'balcony', rows: 4, seatsPerRow: 20, x: 205, y: 270, angle: 0 },
  ],
};

/** Basement Nine: a 120-seat club floor. */
const BASEMENT_NINE: VenueLayout = {
  width: 400,
  height: 240,
  stage: { x: 100, y: 20, w: 200, h: 36, label: 'Stage' },
  tiers: [
    { key: 'front', name: 'Front floor' },
    { key: 'back', name: 'Back floor' },
  ],
  sections: [
    { key: 'FF', name: 'Front Floor', tier: 'front', rows: 4, seatsPerRow: 12, x: 145, y: 90, angle: 0 },
    { key: 'BF', name: 'Back Floor', tier: 'back', rows: 6, seatsPerRow: 12, x: 145, y: 150, angle: 0 },
  ],
};

export const SEED_VENUES: SeedVenue[] = [
  { slug: 'lotus-hall', name: 'Lotus Hall', city: 'Pune', layout: LOTUS_HALL },
  { slug: 'riverside-arena', name: 'Riverside Arena', city: 'Bengaluru', layout: RIVERSIDE_ARENA },
  { slug: 'basement-nine', name: 'Basement Nine', city: 'Mumbai', layout: BASEMENT_NINE },
  { slug: 'bench-stadium', name: 'Bench Stadium', city: 'Testville', layout: BENCH_LAYOUT },
];
