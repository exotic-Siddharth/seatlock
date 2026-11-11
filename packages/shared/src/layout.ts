import type { VenueLayout, VenueSection } from './schemas';

/** Distance between neighbouring seats and rows, in SVG viewBox units. */
export const SEAT_PITCH = 10;
export const SEAT_RADIUS = 3.6;

export type MaterializedSeat = {
  sectionKey: string;
  rowLabel: string;
  seatNumber: number;
  tier: string;
};

/** 'A' -> 1, 'Z' -> 26, 'AA' -> 27 (bijective base 26, like spreadsheet columns). */
function labelToNumber(label: string): number {
  let n = 0;
  for (const ch of label) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function numberToLabel(n: number): string {
  let label = '';
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    label = String.fromCharCode(65 + ((rest - 1) % 26)) + label;
  }
  return label;
}

/** The label of the row `index` rows after `start`: rowLabel('A', 26) === 'AA'. */
export function rowLabel(start: string, index: number): string {
  return numberToLabel(labelToNumber(start) + index);
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Centre of seat `seatNumber` (1-based) in row `rowIndex` (0-based): the seat sits at
 * (x + (n-1)*pitch, y + r*pitch), rotated by `angle` degrees about the section origin (x, y).
 */
export function seatPosition(
  section: Pick<VenueSection, 'x' | 'y' | 'angle'>,
  rowIndex: number,
  seatNumber: number,
): { x: number; y: number } {
  const dx = (seatNumber - 1) * SEAT_PITCH;
  const dy = rowIndex * SEAT_PITCH;
  const rad = (section.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: round(section.x + dx * cos - dy * sin),
    y: round(section.y + dx * sin + dy * cos),
  };
}

/** Every seat in the layout, section by section, row by row, seat by seat. */
export function materializeLayout(layout: VenueLayout): MaterializedSeat[] {
  const seats: MaterializedSeat[] = [];
  for (const section of layout.sections) {
    for (let r = 0; r < section.rows; r++) {
      const label = rowLabel(section.rowLabelStart ?? 'A', r);
      for (let n = 1; n <= section.seatsPerRow; n++) {
        seats.push({ sectionKey: section.key, rowLabel: label, seatNumber: n, tier: section.tier });
      }
    }
  }
  return seats;
}

export function layoutCapacity(layout: VenueLayout): number {
  return layout.sections.reduce((sum, s) => sum + s.rows * s.seatsPerRow, 0);
}

/** "Sec B · Row C · Seat 12" */
export function seatLabel(sectionName: string, rowLabel: string, seatNumber: number): string {
  return `${sectionName} · Row ${rowLabel} · Seat ${seatNumber}`;
}
