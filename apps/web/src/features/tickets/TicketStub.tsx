import type { Order, OrderStatus, Ticket } from '@seatlock/shared';
import { Suspense, lazy } from 'react';
import { Badge, Skeleton, type BadgeTone } from '../../components/ui';
import { formatDate, formatInr, formatTime } from '../../lib/format';
import { endedUnpaid } from '../checkout/card';

// The QR encoder loads with the first ticket shown, not with the page.
const TicketQr = lazy(() => import('./TicketQr').then((m) => ({ default: m.TicketQr })));

const ORDER_STATUS: Record<OrderStatus, { tone: BadgeTone; label: string }> = {
  paid: { tone: 'success', label: 'Paid' },
  pending_payment: { tone: 'warning', label: 'Payment pending' },
  failed: { tone: 'danger', label: 'Payment failed' },
};

/** An order's status. One that ended before anyone paid (released, replaced, expired) is "Cancelled". */
export function OrderStatusBadge({ order }: { order: Pick<Order, 'status' | 'failureReason'> }) {
  const { tone, label } =
    order.status === 'failed' && endedUnpaid(order.failureReason) ? { tone: 'neutral' as const, label: 'Cancelled' } : ORDER_STATUS[order.status];
  return <Badge tone={tone}>{label}</Badge>;
}

/** A tier key as a label: 'gold' -> 'Gold'. Holds, orders and tickets carry the key only. */
export const tierLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

/** One ticket, drawn as a paper ticket: the details, a perforated tear line, and the QR stub. */
export function TicketStub({ ticket, order }: { ticket: Ticket; order: Pick<Order, 'eventTitle' | 'eventStartsAt' | 'venueName'> }) {
  return (
    <article
      aria-label={`Ticket ${ticket.seatLabel}`}
      className="flex rounded-2xl border border-line bg-surface shadow-sm"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.65rem] font-bold tracking-[0.25em] text-accent uppercase">Admit one</span>
          {ticket.checkedInAt ? <Badge tone="success">Checked in</Badge> : <Badge tone="accent">Valid</Badge>}
        </div>
        <div className="min-w-0">
          <p className="truncate font-display text-base font-semibold text-ink">{order.eventTitle}</p>
          <p className="text-xs text-muted">
            {formatDate(order.eventStartsAt)} · {formatTime(order.eventStartsAt)} · {order.venueName}
          </p>
        </div>
        <p className="font-display text-lg leading-tight font-bold text-ink">{ticket.seatLabel}</p>
        <p className="text-xs text-muted">
          {tierLabel(ticket.tier)} · {formatInr(ticket.pricePaise)}
        </p>
      </div>

      {/* Perforation: a dashed line with half-circle notches cut out of both edges. */}
      <div aria-hidden className="relative w-0 border-l-2 border-dashed border-line">
        <span className="absolute -top-px left-0 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line bg-bg [clip-path:inset(50%_0_0_0)]" />
        <span className="absolute -bottom-px left-0 size-5 -translate-x-1/2 translate-y-1/2 rounded-full border border-line bg-bg [clip-path:inset(0_0_50%_0)]" />
      </div>

      <div className="flex w-28 shrink-0 flex-col items-center justify-center gap-2 p-3 sm:w-36 sm:p-4">
        <Suspense fallback={<Skeleton className="aspect-square w-full" />}>
          <TicketQr code={ticket.code} className="w-full" />
        </Suspense>
        <code className="text-center font-mono text-[0.6rem] leading-tight break-all text-muted">{ticket.code}</code>
      </div>
    </article>
  );
}
