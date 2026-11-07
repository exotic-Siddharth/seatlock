import { rowLabel, seatPosition, type VenueLayout } from '@seatlock/shared';

export type Point = { x: number; y: number };
export type ViewBox = { x: number; y: number; w: number; h: number };
export type ScreenRect = { left: number; top: number; width: number; height: number };
export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export type SectionLabel = { key: string; name: string; x: number; y: number; rotate: number };

export type SeatGeometry = {
  /** Centre of a seat, or undefined if the layout has no such seat. */
  position(sectionKey: string, rowLabel: string, seatNumber: number): Point | undefined;
  sectionNames: ReadonlyMap<string, string>;
  sectionLabels: SectionLabel[];
  /** The whole venue: the layout's viewBox. */
  full: ViewBox;
};

const key = (sectionKey: string, row: string, seatNumber: number) => `${sectionKey}|${row}|${seatNumber}`;

/** Keeps text readable: a section turned upside down gets its label turned the right way up. */
function uprightAngle(angle: number): number {
  const a = ((angle % 360) + 360) % 360;
  return a > 90 && a < 270 ? a - 180 : a > 180 ? a - 360 : a;
}

/** Every seat centre of a layout, computed once per layout. */
export function createSeatGeometry(layout: VenueLayout): SeatGeometry {
  const positions = new Map<string, Point>();
  const sectionNames = new Map<string, string>();
  const sectionLabels: SectionLabel[] = [];

  for (const section of layout.sections) {
    sectionNames.set(section.key, section.name);
    for (let r = 0; r < section.rows; r++) {
      const row = rowLabel(section.rowLabelStart ?? 'A', r);
      for (let n = 1; n <= section.seatsPerRow; n++) positions.set(key(section.key, row, n), seatPosition(section, r, n));
    }
    // Centred on the section, a little behind its last row (row A faces the stage).
    const at = seatPosition(section, section.rows - 1 + 1.3, (section.seatsPerRow + 1) / 2);
    sectionLabels.push({ key: section.key, name: section.name, ...at, rotate: uprightAngle(section.angle) });
  }

  return {
    position: (sectionKey, row, seatNumber) => positions.get(key(sectionKey, row, seatNumber)),
    sectionNames,
    sectionLabels,
    full: { x: 0, y: 0, w: layout.width, h: layout.height },
  };
}

// ---------------------------------------------------------------- viewBox maths
// The SVG uses preserveAspectRatio="xMidYMid meet": the viewBox is scaled uniformly to fit the
// element and centred, so some screen space may lie outside it.

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Screen pixels per viewBox unit; 0 while the element has no size. */
export function pixelsPerUnit(vb: ViewBox, rect: ScreenRect): number {
  return Math.min(rect.width / vb.w, rect.height / vb.h);
}

export function clientToSvg(vb: ViewBox, rect: ScreenRect, clientX: number, clientY: number): Point {
  const scale = pixelsPerUnit(vb, rect);
  return {
    x: vb.x + (clientX - rect.left - (rect.width - vb.w * scale) / 2) / scale,
    y: vb.y + (clientY - rect.top - (rect.height - vb.h * scale) / 2) / scale,
  };
}

export function svgToClient(vb: ViewBox, rect: ScreenRect, p: Point): Point {
  const scale = pixelsPerUnit(vb, rect);
  return {
    x: rect.left + (rect.width - vb.w * scale) / 2 + (p.x - vb.x) * scale,
    y: rect.top + (rect.height - vb.h * scale) / 2 + (p.y - vb.y) * scale,
  };
}

/** Scales the view by `factor` (below 1 zooms in) about `focus`, which keeps its place on screen. */
export function zoomViewBox(vb: ViewBox, factor: number, focus: Point, limits: { minW: number; maxW: number }): ViewBox {
  const w = clamp(vb.w * factor, limits.minW, limits.maxW);
  const k = w / vb.w;
  return { x: focus.x - (focus.x - vb.x) * k, y: focus.y - (focus.y - vb.y) * k, w, h: vb.h * k };
}

/** Moves the view so its centre stays over the venue: you can't pan the seats out of sight. */
export function clampViewBox(vb: ViewBox, full: ViewBox): ViewBox {
  const cx = clamp(vb.x + vb.w / 2, full.x, full.x + full.w);
  const cy = clamp(vb.y + vb.h / 2, full.y, full.y + full.h);
  return { x: cx - vb.w / 2, y: cy - vb.h / 2, w: vb.w, h: vb.h };
}

const DIRECTIONS: Record<ArrowKey, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * Spatial keyboard navigation: the id of the seat an arrow key should move to from `from`, or
 * null at the edge. It favours seats straight ahead over ones off to the side, so it follows
 * rows and also crosses gaps between angled sections.
 */
export function nearestSeatInDirection(
  seats: Iterable<Point & { id: number }>,
  from: Point,
  arrow: ArrowKey,
): number | null {
  const d = DIRECTIONS[arrow];
  let best: number | null = null;
  let bestScore = Infinity;
  for (const seat of seats) {
    const dx = seat.x - from.x;
    const dy = seat.y - from.y;
    const ahead = dx * d.x + dy * d.y;
    if (ahead < 1) continue;
    const aside = Math.abs(dx * d.y - dy * d.x);
    const score = ahead + 3 * aside;
    if (score < bestScore) {
      bestScore = score;
      best = seat.id;
    }
  }
  return best;
}
