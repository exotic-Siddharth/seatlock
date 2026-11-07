import type { Order } from '@seatlock/shared';
import { CalendarDays, CircleCheck, CircleX, MapPin } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { EmptyState, Skeleton, Spinner, buttonClass } from '../components/ui';
import { declineMessage, failureMessage } from '../features/checkout/card';
import { useOrder } from '../features/checkout/queries';
import { LoadError } from '../features/events/LoadError';
import { TicketStub } from '../features/tickets/TicketStub';
import { formatDate, formatInr, formatTime } from '../lib/format';

export default function OrderConfirmation() {
  const { id = '' } = useParams();
  const order = useOrder(id);

  if (order.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <span role="status" className="sr-only">
          Loading your order
        </span>
        <Skeleton className="h-28 rounded-2xl" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-44 rounded-2xl" />
        </div>
      </div>
    );
  }
  if (order.isLoadingError) {
    return (
      <LoadError
        error={order.error}
        onRetry={() => void order.refetch()}
        title="Could not load your order"
        notFoundTitle="Order not found"
        notFoundBody="This order is not yours, or it does not exist."
      />
    );
  }
  return <OrderView order={order.data} />;
}

function OrderView({ order }: { order: Order }) {
  if (order.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleX aria-hidden />}
        title="Payment failed"
        body={failureMessage(order.failureReason)}
        action={
          <Link to={`/events/${order.eventSlug}`} className={buttonClass('primary')}>
            Back to the seat map
          </Link>
        }
      />
    );
  }
  if (order.status === 'pending_payment') {
    return (
      <EmptyState
        icon={<Spinner />}
        title={order.lastPaymentError ? 'Payment not completed' : 'Confirming your payment'}
        body={
          order.lastPaymentError
            ? `${declineMessage(order.lastPaymentError)} Your seats are held until the timer at checkout runs out.`
            : 'MockPay is confirming your card. This page updates by itself.'
        }
        action={
          <Link to={`/checkout/${order.holdId}`} className={buttonClass('secondary')}>
            Back to checkout
          </Link>
        }
      />
    );
  }

  const count = order.tickets.length;
  return (
    <div className="flex flex-col gap-8">
      <header className="relative overflow-hidden rounded-3xl bg-ink p-6 text-bg sm:p-10">
        <div
          aria-hidden
          className="absolute -top-16 -right-16 size-64 rounded-full bg-[radial-gradient(circle,var(--accent)_0,transparent_70%)] opacity-60"
        />
        <div className="relative flex flex-col gap-3">
          <p className="inline-flex items-center gap-2 text-sm font-semibold tracking-widest text-accent uppercase">
            <CircleCheck aria-hidden className="size-4" /> Paid · {formatInr(order.amountPaise)}
          </p>
          <h1 className="font-display text-3xl font-bold tracking-tight text-balance sm:text-5xl">You're going to {order.eventTitle}!</h1>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 opacity-80">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays aria-hidden className="size-4" />
              {formatDate(order.eventStartsAt)} · {formatTime(order.eventStartsAt)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <MapPin aria-hidden className="size-4" />
              {order.venueName}
            </span>
          </p>
          <p className="text-sm opacity-70">
            {count} {count === 1 ? 'ticket' : 'tickets'}. Show the QR code at the door; each one gets you in once.
          </p>
        </div>
      </header>

      <ul aria-label="Your tickets" className="grid gap-4 md:grid-cols-2">
        {order.tickets.map((ticket) => (
          <li key={ticket.id}>
            <TicketStub ticket={ticket} order={order} />
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-3">
        <Link to="/tickets" className={buttonClass('primary')}>
          All my tickets
        </Link>
        <Link to="/" className={buttonClass('secondary')}>
          Find another event
        </Link>
      </div>
    </div>
  );
}
