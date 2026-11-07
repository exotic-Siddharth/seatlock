import { describe, expect, it } from 'vitest';
import {
  VenueLayoutSchema,
  layoutCapacity,
  materializeLayout,
  rowLabel,
  seatLabel,
  seatPosition,
  type VenueLayout,
} from '../src';

const layout: VenueLayout = {
  width: 400,
  height: 300,
  stage: { x: 100, y: 10, w: 200, h: 30, label: 'Stage' },
  tiers: [
    { key: 'gold', name: 'Gold' },
    { key: 'silver', name: 'Silver' },
  ],
  sections: [
    { key: 'A', name: 'Sec A', tier: 'gold', rows: 3, seatsPerRow: 10, x: 50, y: 80, angle: 0 },
    { key: 'B', name: 'Sec B', tier: 'silver', rows: 2, seatsPerRow: 7, x: 250, y: 80, angle: 15, rowLabelStart: 'F' },
  ],
};

describe('rowLabel', () => {
  it('counts A..Z then AA, AB, like spreadsheet columns', () => {
    expect(rowLabel('A', 0)).toBe('A');
    expect(rowLabel('A', 25)).toBe('Z');
    expect(rowLabel('A', 26)).toBe('AA');
    expect(rowLabel('A', 27)).toBe('AB');
    expect(rowLabel('A', 701)).toBe('ZZ');
    expect(rowLabel('A', 702)).toBe('AAA');
  });

  it('starts from a custom label', () => {
    expect(rowLabel('C', 2)).toBe('E');
    expect(rowLabel('Z', 1)).toBe('AA');
  });
});

describe('seatPosition', () => {
  const section = { x: 100, y: 50, angle: 0 };

  it('places seats on a 10-unit pitch from the top-left of row A, seat 1', () => {
    expect(seatPosition(section, 0, 1)).toEqual({ x: 100, y: 50 });
    expect(seatPosition(section, 2, 3)).toEqual({ x: 120, y: 70 });
  });

  it('rotates about (x, y): at 90 degrees (x+10, y) maps to (x, y+10)', () => {
    const p = seatPosition({ ...section, angle: 90 }, 0, 2);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(60);
  });
});

describe('materializeLayout', () => {
  it('creates rows x seatsPerRow seats per section', () => {
    const seats = materializeLayout(layout);
    expect(seats).toHaveLength(3 * 10 + 2 * 7);
    expect(layoutCapacity(layout)).toBe(seats.length);
  });

  it('labels rows from rowLabelStart and numbers seats from 1', () => {
    const seats = materializeLayout(layout);
    expect(seats[0]).toEqual({ sectionKey: 'A', rowLabel: 'A', seatNumber: 1, tier: 'gold' });
    const sectionB = seats.filter((s) => s.sectionKey === 'B');
    expect(new Set(sectionB.map((s) => s.rowLabel))).toEqual(new Set(['F', 'G']));
    expect(sectionB.every((s) => s.tier === 'silver')).toBe(true);
  });
});

describe('seatLabel', () => {
  it('formats a human-readable seat label', () => {
    expect(seatLabel('Sec B', 'C', 12)).toBe('Sec B · Row C · Seat 12');
  });
});

describe('VenueLayoutSchema', () => {
  it('accepts a valid layout', () => {
    expect(VenueLayoutSchema.safeParse(layout).success).toBe(true);
  });

  it('rejects a section whose tier is not declared', () => {
    const bad = { ...layout, sections: [{ ...layout.sections[0], tier: 'platinum' }] };
    expect(VenueLayoutSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate section keys', () => {
    const bad = { ...layout, sections: [layout.sections[0], layout.sections[0]] };
    expect(VenueLayoutSchema.safeParse(bad).success).toBe(false);
  });
});
