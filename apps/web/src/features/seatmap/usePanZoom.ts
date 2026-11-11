import { SEAT_PITCH } from '@seatlock/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { clampViewBox, clientToSvg, pixelsPerUnit, zoomViewBox, type Point, type ViewBox } from './geometry';

/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 5;
const BUTTON_ZOOM = 0.7;

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Pan and zoom for the seat map by changing the SVG viewBox: wheel and +/- buttons zoom, one
 * pointer drags, two pointers pinch. Only the viewBox attribute changes, so the seats
 * themselves never re-render while the view moves.
 */
export function usePanZoom(full: ViewBox) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewBox, setViewBox] = useState(full);
  const pointers = useRef(new Map<number, Point>());
  const pressedAt = useRef<Point | null>(null);
  const dragged = useRef(false);

  // Zoom in until about eight seats fill the width; never out past the whole venue.
  const limits = useMemo(() => ({ minW: Math.min(full.w, 8 * SEAT_PITCH), maxW: full.w }), [full.w]);

  useEffect(() => setViewBox(full), [full]);

  const update = useCallback((change: (vb: ViewBox) => ViewBox) => setViewBox((vb) => clampViewBox(change(vb), full)), [full]);

  /** Zooms about a screen point, or about the centre of the view. */
  const zoomBy = useCallback(
    (factor: number, client?: Point) =>
      update((vb) => {
        const rect = svgRef.current?.getBoundingClientRect();
        const focus =
          client && rect && pixelsPerUnit(vb, rect) > 0
            ? clientToSvg(vb, rect, client.x, client.y)
            : { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
        return zoomViewBox(vb, factor, focus, limits);
      }),
    [update, limits],
  );

  /** Pans so that `p` is in view, if it isn't already (keyboard focus moving off-screen). */
  const reveal = useCallback(
    (p: Point) =>
      update((vb) => {
        const margin = SEAT_PITCH;
        const inside = p.x > vb.x + margin && p.x < vb.x + vb.w - margin && p.y > vb.y + margin && p.y < vb.y + vb.h - margin;
        return inside ? vb : { ...vb, x: p.x - vb.w / 2, y: p.y - vb.h / 2 };
      }),
    [update],
  );

  // React registers wheel listeners as passive, and a passive listener can't stop the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const px = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
      zoomBy(Math.exp(px * 0.002), { x: e.clientX, y: e.clientY });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const onPointerDown = (e: ReactPointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      pressedAt.current = { x: e.clientX, y: e.clientY };
      dragged.current = false;
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      // The button was released somewhere we never heard about.
      pointers.current.delete(e.pointerId);
      return;
    }
    const next = { x: e.clientX, y: e.clientY };

    if (pointers.current.size >= 2) {
      const other = [...pointers.current].find(([id]) => id !== e.pointerId)![1];
      dragged.current = true;
      zoomBy(distance(prev, other) / distance(next, other), { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 });
    } else {
      if (!dragged.current) {
        if (distance(next, pressedAt.current ?? next) < DRAG_THRESHOLD_PX) return;
        dragged.current = true;
        // Captured only once it is a drag: capturing on press would retarget the click away from the seat.
        svgRef.current?.setPointerCapture?.(e.pointerId);
      }
      update((vb) => {
        const rect = svgRef.current?.getBoundingClientRect();
        const scale = rect ? pixelsPerUnit(vb, rect) : 0;
        if (!scale) return vb;
        return { ...vb, x: vb.x - (next.x - prev.x) / scale, y: vb.y - (next.y - prev.y) / scale };
      });
    }
    pointers.current.set(e.pointerId, next);
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
  };

  /** True once, for the click that ends a drag or pinch, which must not toggle a seat. */
  const consumeDrag = () => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  };

  return {
    svgRef,
    viewBox,
    zoomIn: () => zoomBy(BUTTON_ZOOM),
    zoomOut: () => zoomBy(1 / BUTTON_ZOOM),
    reset: () => setViewBox(full),
    reveal,
    consumeDrag,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
