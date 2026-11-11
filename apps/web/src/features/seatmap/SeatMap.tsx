import { SEAT_RADIUS, formatInr, type SeatCode, type SeatTuple, type VenueLayout } from '@seatlock/shared';
import { Maximize, Minus, Plus } from 'lucide-react';
import { memo, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { cx } from '../../components/ui';
import { createSeatGeometry, nearestSeatInDirection, svgToClient, type ArrowKey, type SeatGeometry } from './geometry';
import { usePanZoom } from './usePanZoom';
import './seatmap.css';

export type SeatMapProps = {
  layout: VenueLayout;
  seats: SeatTuple[];
  selected: ReadonlySet<number>;
  /** Seats in the visitor's own active hold. */
  mine: ReadonlySet<number>;
  /** Paise per tier key. */
  tierPrices: Record<string, number>;
  /** Called for a click or Enter on a seat that can be picked or unpicked. */
  onToggle(id: number): void;
  /** Seats to flash, e.g. the ones a hold attempt just lost. */
  flashIds?: ReadonlySet<number>;
};

type TierInfo = { index: number; name: string; price: string };

const STATUS_WORDS: Record<SeatCode, string> = { A: 'available', H: 'held', S: 'sold' };
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

function seatState(status: SeatCode, selected: boolean, mine: boolean): string {
  if (selected) return 'selected';
  if (mine) return 'held by you';
  return STATUS_WORDS[status];
}

type SeatDotProps = {
  id: number;
  x: number;
  y: number;
  section: string;
  row: string;
  number: number;
  tier: TierInfo | undefined;
  status: SeatCode;
  selected: boolean;
  mine: boolean;
  flash: boolean;
  tabbable: boolean;
};

/** One seat. Memoised on primitive props, so a live update re-renders only the seats it changes. */
const SeatDot = memo(function SeatDot({ id, x, y, section, row, number, tier, status, selected, mine, flash, tabbable }: SeatDotProps) {
  const look = selected
    ? 'seat-selected'
    : mine
      ? 'seat-mine'
      : status === 'A'
        ? `seat-tier-${(tier?.index ?? 0) % 4}`
        : status === 'H'
          ? 'seat-held'
          : 'seat-sold';
  return (
    <circle
      data-seat-id={id}
      cx={x}
      cy={y}
      r={SEAT_RADIUS}
      role="button"
      tabIndex={tabbable ? 0 : -1}
      aria-label={`${section}, Row ${row}, Seat ${number}, ${tier?.name ?? 'Unpriced'}, ${tier?.price ?? '-'}, ${seatState(status, selected, mine)}`}
      aria-pressed={selected}
      aria-disabled={selected || status === 'A' ? undefined : true}
      className={cx('seat', look, flash && 'seat-flash')}
    />
  );
});

type SeatLayerProps = {
  seats: SeatTuple[];
  geometry: SeatGeometry;
  tiers: ReadonlyMap<string, TierInfo>;
  selected: ReadonlySet<number>;
  mine: ReadonlySet<number>;
  flashIds: ReadonlySet<number> | undefined;
  tabbableId: number | null;
};

/** All the seats. Memoised so that panning, zooming and tooltips don't touch them at all. */
const SeatLayer = memo(function SeatLayer({ seats, geometry, tiers, selected, mine, flashIds, tabbableId }: SeatLayerProps) {
  return (
    <g>
      {seats.map(([id, sectionKey, row, number, tier, status]) => {
        const p = geometry.position(sectionKey, row, number);
        if (!p) return null;
        return (
          <SeatDot
            key={id}
            id={id}
            x={p.x}
            y={p.y}
            section={geometry.sectionNames.get(sectionKey) ?? sectionKey}
            row={row}
            number={number}
            tier={tiers.get(tier)}
            status={status}
            selected={selected.has(id)}
            mine={mine.has(id)}
            flash={flashIds?.has(id) ?? false}
            tabbable={id === tabbableId}
          />
        );
      })}
    </g>
  );
});

const seatIdOf = (target: EventTarget | null): number | null => {
  const id = target instanceof Element ? target.getAttribute('data-seat-id') : null;
  return id ? Number(id) : null;
};

type Tooltip = { id: number; left: number; top: number };

/**
 * The live seat map: an SVG drawn from the venue layout, with one focusable circle per seat
 * coloured by price tier. Pan and zoom move the viewBox; arrow keys move between seats.
 */
export function SeatMap({ layout, seats, selected, mine, tierPrices, onToggle, flashIds }: SeatMapProps) {
  const geometry = useMemo(() => createSeatGeometry(layout), [layout]);
  const tiers = useMemo(
    () => new Map(layout.tiers.map((t, index) => [t.key, { index, name: t.name, price: formatInr(tierPrices[t.key] ?? 0) }])),
    [layout.tiers, tierPrices],
  );
  const seatById = useMemo(() => new Map(seats.map((s) => [s[0], s])), [seats]);
  const firstOpenSeat = useMemo(() => (seats.find((s) => s[5] === 'A') ?? seats[0])?.[0] ?? null, [seats]);
  const panZoom = usePanZoom(geometry.full);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const helpId = useId();

  // The seat in the tab order: the last one focused, else the first available.
  const tabbableId = activeId !== null && seatById.has(activeId) ? activeId : firstOpenSeat;

  const positionOf = (id: number) => {
    const seat = seatById.get(id);
    return seat && geometry.position(seat[1], seat[2], seat[3]);
  };
  const canToggle = (id: number) => selected.has(id) || seatById.get(id)?.[5] === 'A';

  const onClick = (e: { target: EventTarget }) => {
    if (panZoom.consumeDrag()) return;
    const id = seatIdOf(e.target);
    if (id !== null && canToggle(id)) onToggle(id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const id = seatIdOf(e.target);
    if (id === null) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (canToggle(id)) onToggle(id);
    } else if (ARROWS.has(e.key)) {
      e.preventDefault();
      const from = positionOf(id);
      if (!from) return;
      const points = seats.flatMap(([sid, sectionKey, row, number]) => {
        const p = geometry.position(sectionKey, row, number);
        return p ? [{ id: sid, ...p }] : [];
      });
      const next = nearestSeatInDirection(points, from, e.key as ArrowKey);
      if (next === null) return;
      setActiveId(next);
      panZoom.reveal(positionOf(next)!);
      panZoom.svgRef.current?.querySelector<SVGElement>(`[data-seat-id="${next}"]`)?.focus();
    }
  };

  const showTooltipAt = (id: number, clientX: number, clientY: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (box) setTooltip({ id, left: clientX - box.left, top: clientY - box.top });
  };

  const onPointerOver = (e: PointerEvent) => {
    const id = seatIdOf(e.target);
    if (id === null || e.buttons !== 0) return setTooltip(null);
    showTooltipAt(id, e.clientX, e.clientY);
  };

  const onFocus = (e: FocusEvent) => {
    const id = seatIdOf(e.target);
    const svg = panZoom.svgRef.current;
    const p = id === null ? undefined : positionOf(id);
    if (id === null || !p || !svg) return;
    setActiveId(id);
    const at = svgToClient(panZoom.viewBox, svg.getBoundingClientRect(), p);
    showTooltipAt(id, at.x, at.y);
  };

  const { x, y, w, h } = panZoom.viewBox;
  // Section names stay legible when the whole of a large venue is in view.
  const labelSize = Math.max(6, layout.width / 85);
  const tip = tooltip && seatById.get(tooltip.id);
  const tipTier = tip && tiers.get(tip[4]);

  return (
    <div ref={containerRef} className="relative">
      <p id={helpId} className="sr-only">
        Use the arrow keys to move between seats and Enter to pick one. Drag to pan; scroll, pinch or use the zoom buttons to zoom.
      </p>
      <div
        className="relative min-h-80 w-full overflow-hidden rounded-2xl border border-line bg-surface max-h-[70vh]"
        style={{ aspectRatio: `${layout.width} / ${layout.height}` }}
      >
        <svg
          ref={panZoom.svgRef}
          data-seatmap
          viewBox={`${x} ${y} ${w} ${h}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label="Seat map"
          aria-describedby={helpId}
          className="size-full cursor-grab touch-none select-none active:cursor-grabbing"
          onClick={onClick}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={() => setTooltip(null)}
          onPointerOver={onPointerOver}
          onPointerLeave={() => setTooltip(null)}
          {...panZoom.handlers}
        >
          <defs>
            <pattern id="seatlock-sold-hatch" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="2.4" height="2.4" className="seat-hatch-bg" />
              <rect width="0.9" height="2.4" className="seat-hatch-line" />
            </pattern>
          </defs>
          <rect
            x={layout.stage.x}
            y={layout.stage.y}
            width={layout.stage.w}
            height={layout.stage.h}
            rx={Math.min(6, layout.stage.h / 3)}
            className="seat-stage"
          />
          <text
            x={layout.stage.x + layout.stage.w / 2}
            y={layout.stage.y + layout.stage.h / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={Math.min(layout.stage.h * 0.4, layout.stage.w / 7)}
            className="seat-stage-label"
            aria-hidden
          >
            {layout.stage.label}
          </text>
          {geometry.sectionLabels.map((label) => (
            <text
              key={label.key}
              x={label.x}
              y={label.y}
              transform={`rotate(${label.rotate} ${label.x} ${label.y})`}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={labelSize}
              className="seat-section-label"
              aria-hidden
            >
              {label.name}
            </text>
          ))}
          <SeatLayer
            seats={seats}
            geometry={geometry}
            tiers={tiers}
            selected={selected}
            mine={mine}
            flashIds={flashIds}
            tabbableId={tabbableId}
          />
        </svg>

        <div className="absolute top-3 right-3 flex flex-col overflow-hidden rounded-xl border border-line bg-surface/90 shadow-sm backdrop-blur">
          {[
            { label: 'Zoom in', icon: Plus, onClick: panZoom.zoomIn },
            { label: 'Zoom out', icon: Minus, onClick: panZoom.zoomOut },
            { label: 'Show the whole venue', icon: Maximize, onClick: panZoom.reset },
          ].map(({ label, icon: Icon, onClick: action }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              title={label}
              onClick={action}
              className="flex size-9 items-center justify-center text-ink transition-colors not-last:border-b not-last:border-line hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <Icon aria-hidden className="size-4" />
            </button>
          ))}
        </div>
      </div>

      {tip && tooltip && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10 w-max max-w-60 -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-lg bg-ink px-3 py-2 text-xs text-bg shadow-lg"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <p className="font-semibold">
            {geometry.sectionNames.get(tip[1]) ?? tip[1]} · Row {tip[2]} · Seat {tip[3]}
          </p>
          <p className="opacity-80">
            {tipTier?.name} · {tipTier?.price} · {seatState(tip[5], selected.has(tip[0]), mine.has(tip[0]))}
          </p>
        </div>
      )}
    </div>
  );
}
