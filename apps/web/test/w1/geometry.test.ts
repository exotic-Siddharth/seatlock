import { describe, expect, it } from 'vitest';
import {
  clampViewBox,
  clientToSvg,
  createSeatGeometry,
  nearestSeatInDirection,
  svgToClient,
  zoomViewBox,
} from '../../src/features/seatmap/geometry';
import { LAYOUT } from './fixtures';

const rect = { left: 100, top: 50, width: 800, height: 400 };

describe('createSeatGeometry', () => {
  it('places every seat of the layout with the shared seat formula', () => {
    const geometry = createSeatGeometry(LAYOUT);
    expect(geometry.position('A', 'A', 1)).toEqual({ x: 40, y: 80 });
    expect(geometry.position('A', 'B', 3)).toEqual({ x: 60, y: 90 });
    expect(geometry.position('B', 'A', 1)).toEqual({ x: 260, y: 80 });
    expect(geometry.position('A', 'Z', 1)).toBeUndefined();
  });

  it('rotates angled sections about their origin', () => {
    const geometry = createSeatGeometry({
      ...LAYOUT,
      sections: [{ key: 'W', name: 'West', tier: 'gold', rows: 2, seatsPerRow: 2, x: 100, y: 100, angle: 90 }],
    });
    expect(geometry.position('W', 'A', 2)).toEqual({ x: 100, y: 110 });
    expect(geometry.position('W', 'B', 1)).toEqual({ x: 90, y: 100 });
  });

  it('puts each section label behind its last row, upright', () => {
    const geometry = createSeatGeometry(LAYOUT);
    const [a] = geometry.sectionLabels;
    expect(a).toMatchObject({ key: 'A', name: 'Sec A', x: 55 });
    expect(a!.y).toBeGreaterThan(90);
    expect(a!.rotate).toBe(0);
  });
});

describe('viewBox helpers', () => {
  const vb = { x: 0, y: 0, w: 400, h: 200 };

  it('converts between screen and SVG coordinates (letterboxed, meet)', () => {
    // 800x400 px shows 400x200 units at 2 px per unit.
    expect(clientToSvg(vb, rect, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(clientToSvg(vb, rect, 500, 250)).toEqual({ x: 200, y: 100 });
    expect(svgToClient(vb, rect, { x: 200, y: 100 })).toEqual({ x: 500, y: 250 });
    // A square viewBox in the same box is centred with 200 px bars on each side.
    expect(clientToSvg({ x: 0, y: 0, w: 200, h: 200 }, rect, 300, 50)).toEqual({ x: 0, y: 0 });
  });

  it('zooms about a focus point, which stays put on screen', () => {
    const focus = { x: 100, y: 50 };
    const zoomed = zoomViewBox(vb, 0.5, focus, { minW: 40, maxW: 400 });
    expect(zoomed).toEqual({ x: 50, y: 25, w: 200, h: 100 });
    expect(svgToClient(zoomed, rect, focus)).toEqual(svgToClient(vb, rect, focus));
  });

  it('clamps the zoom between the limits', () => {
    expect(zoomViewBox(vb, 0.01, { x: 0, y: 0 }, { minW: 40, maxW: 400 }).w).toBe(40);
    expect(zoomViewBox(vb, 10, { x: 0, y: 0 }, { minW: 40, maxW: 400 }).w).toBe(400);
  });

  it('keeps the centre of the view over the venue', () => {
    expect(clampViewBox({ x: -500, y: 900, w: 100, h: 50 }, vb)).toEqual({ x: -50, y: 175, w: 100, h: 50 });
    expect(clampViewBox({ x: 10, y: 10, w: 100, h: 50 }, vb)).toEqual({ x: 10, y: 10, w: 100, h: 50 });
  });
});

describe('nearestSeatInDirection', () => {
  const points = [
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 10, y: 0 },
    { id: 3, x: 20, y: 0 },
    { id: 4, x: 10, y: 10 },
    { id: 5, x: 30, y: 12 },
  ];

  it('picks the closest seat in the arrow direction, preferring the same line', () => {
    expect(nearestSeatInDirection(points, points[0]!, 'ArrowRight')).toBe(2);
    expect(nearestSeatInDirection(points, points[1]!, 'ArrowDown')).toBe(4);
    expect(nearestSeatInDirection(points, points[1]!, 'ArrowLeft')).toBe(1);
    expect(nearestSeatInDirection(points, points[3]!, 'ArrowUp')).toBe(2);
  });

  it('returns null at the edge', () => {
    expect(nearestSeatInDirection(points, points[0]!, 'ArrowLeft')).toBeNull();
    expect(nearestSeatInDirection(points, points[0]!, 'ArrowUp')).toBeNull();
  });
});
