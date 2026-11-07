import type { ReactNode } from 'react';

/*
 * The spec section 3 diagram, drawn by hand: browser -> nginx -> two API replicas -> Postgres and Redis,
 * k6 hitting nginx, and MockPay's signed webhook coming back in. Colours are theme variables, so the
 * diagram follows light and dark mode.
 */

type NodeProps = { x: number; y: number; w: number; h: number; title: string; lines: string[]; tone?: 'plain' | 'store' | 'tool' };

const TONE_STROKE = { plain: 'var(--line)', store: 'var(--tier-2)', tool: 'var(--tier-3)' } as const;

function Node({ x, y, w, h, title, lines, tone = 'plain' }: NodeProps) {
  const top = y + h / 2 - ((lines.length - 1) * 8 + 6);
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={14} style={{ fill: 'var(--surface)', stroke: TONE_STROKE[tone], strokeWidth: tone === 'plain' ? 1.5 : 2 }} />
      <text x={x + w / 2} y={top} textAnchor="middle" className="font-display" style={{ fill: 'var(--ink)', fontSize: 16, fontWeight: 700 }}>
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={x + w / 2} y={top + 20 + i * 16} textAnchor="middle" style={{ fill: 'var(--muted)', fontSize: 12 }}>
          {line}
        </text>
      ))}
    </g>
  );
}

function Label({ x, y, anchor = 'middle', children }: { x: number; y: number; anchor?: 'start' | 'middle' | 'end'; children: ReactNode }) {
  return (
    <text x={x} y={y} textAnchor={anchor} style={{ fill: 'var(--muted)', fontSize: 11.5, fontWeight: 500 }}>
      {children}
    </text>
  );
}

const LINE = { stroke: 'var(--muted)', strokeWidth: 1.6, fill: 'none', markerEnd: 'url(#arrow)' } as const;
const FAINT = { ...LINE, strokeWidth: 1.2, opacity: 0.45 } as const;

export function ArchitectureDiagram() {
  return (
    <svg
      viewBox="0 0 960 440"
      role="img"
      aria-labelledby="arch-title arch-desc"
      className="h-auto w-full"
      style={{ fontFamily: 'var(--font-sans)' }}
    >
      <title id="arch-title">Seatlock architecture diagram</title>
      <desc id="arch-desc">
        The browser talks to nginx over REST and server-sent events. nginx load-balances across two API replicas. Both replicas use
        PostgreSQL as the source of truth and Redis for sessions, the waiting room, seat gates, pub/sub, rate limits and leader locks. The k6
        load generator sends traffic to nginx. MockPay calls back with a signed webhook through nginx to the API.
      </desc>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" style={{ fill: 'var(--muted)' }} />
        </marker>
        <marker id="arrow-accent" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" style={{ fill: 'var(--accent)' }} />
        </marker>
      </defs>

      <Node x={20} y={167} w={170} h={96} title="Browser" lines={['React SPA, seat map', 'SSE, TanStack Query']} />
      <Node x={270} y={167} w={170} h={96} title="nginx" lines={['static web +', 'load balancer']} />
      <Node x={270} y={18} w={170} h={72} title="k6" lines={['load generator']} tone="tool" />
      <Node x={560} y={40} w={170} h={96} title="API replica 1" lines={['Express 5', 'holds, orders, SSE']} />
      <Node x={560} y={294} w={170} h={96} title="API replica 2" lines={['Express 5', 'holds, orders, SSE']} />
      <Node x={790} y={40} w={150} h={96} title="PostgreSQL 16" lines={['source of truth', 'seats, holds, orders']} tone="store" />
      <Node x={790} y={294} w={150} h={96} title="Redis 7" lines={['sessions, queue, gates', 'pub/sub, limits, locks']} tone="store" />

      <path d="M192 215 H268" style={LINE} />
      <Label x={230} y={204}>REST + SSE</Label>
      <path d="M355 92 V165" style={LINE} />
      <Label x={365} y={134} anchor="start">load</Label>

      <path d="M442 195 L558 100" style={LINE} />
      <path d="M442 235 L558 330" style={LINE} />
      <Label x={499} y={196}>load balanced</Label>

      <path d="M732 88 H788" style={LINE} />
      <Label x={760} y={76}>pg pool</Label>
      <path d="M732 342 H788" style={LINE} />
      <Label x={760} y={330}>ioredis</Label>
      <path d="M732 118 L788 312" style={FAINT} />
      <path d="M732 312 L788 118" style={FAINT} />

      <path
        d="M558 366 C 470 400, 355 380, 355 265"
        style={{ stroke: 'var(--accent)', strokeWidth: 2, fill: 'none', strokeDasharray: '7 5', markerEnd: 'url(#arrow-accent)' }}
      />
      <rect x={338} y={398} width={330} height={30} rx={15} style={{ fill: 'var(--surface)', stroke: 'var(--accent)', strokeWidth: 1.5 }} />
      <text x={503} y={418} textAnchor="middle" style={{ fill: 'var(--accent)', fontSize: 12.5, fontWeight: 600 }}>
        Webhook loop: MockPay signs, calls back over HTTP
      </text>
    </svg>
  );
}
