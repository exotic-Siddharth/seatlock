import type { Order } from '@seatlock/shared';
import { Ticket } from 'lucide-react';
import { Link } from 'react-router';
import { Card, EmptyState, Skeleton, buttonClass } from '../components/ui';
import { failureMessage } from '../features/checkout/card';
import { useMyOrders } from '../features/checkout/queries';
import { LoadError } from '../features/events/LoadError';
import { OrderStatusBadge, TicketStub } from '../features/tickets/TicketStub';
import { formatDate, formatDateTime, formatInr, formatTime } from '../lib/format';

export default function Tickets() {
  const orders = useMyOrders();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">My tickets</h1>
        <p className="mt-1 text-muted">Every order you have placed, newest first.</p>
      </div>
      {orders.isPending ? (
        <div className="flex flex-col gap-4">
          <span role="status" className="sr-only">
            Loading your tickets
          </span>
          <Skeleton className="h-56 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
      ) : orders.isError ? (
        <LoadError error={orders.error} onRetry={() => void orders.refetch()} title="Could not load your tickets" />
      ) : orders.data.length === 0 ? (
        <EmptyState
          icon={<Ticket aria-hidden />}
          title="No tickets yet"
          body="Pick seats for a show and your tickets, with their QR codes, will be waiting here."
          action={
            <Link to="/" className={buttonClass('primary')}>
              Browse events
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col gap-6">
          {orders.data.map((order) => (
            <li key={order.id}>
              <OrderCard order={order} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderCard({ order }: { order: Order }) {
  // Approximate (device clock): the checkout page itself shows the exact time left.
  const holdActive = Date.parse(order.holdExpiresAt) > Date.now();
  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/events/${order.eventSlug}`} className="font-display text-xl font-semibold text-ink hover:text-accent">
            {order.eventTitle}
          </Link>
          <p className="text-sm text-muted">
            {formatDate(order.eventStartsAt)} · {formatTime(order.eventStartsAt)} · {order.venueName}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-display font-semibold text-ink tabular-nums">{formatInr(order.amountPaise)}</span>
          <OrderStatusBadge status={order.status} />
        </div>
      </div>

      {order.status === 'paid' && (
        <ul className="grid gap-4 md:grid-cols-2">
          {order.tickets.map((ticket) => (
            <li key={ticket.id}>
              <TicketStub ticket={ticket} order={order} />
            </li>
          ))}
        </ul>
      )}
      {order.status === 'failed' && <p className="text-sm text-muted">{failureMessage(order.failureReason)}</p>}
      {order.status === 'pending_payment' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-2 p-3 text-sm">
          <span className="text-muted">
            {holdActive ? `Seats held until ${formatTime(order.holdExpiresAt)}.` : `The hold ran out at ${formatDateTime(order.holdExpiresAt)}.`}
          </span>
          {holdActive && (
            <Link to={`/checkout/${order.holdId}`} className={buttonClass('primary', 'sm')}>
              Continue checkout
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}
