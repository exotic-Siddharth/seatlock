import type { Hold } from '@seatlock/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Clock4, Hourglass, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { Button, Card, EmptyState, Modal, Skeleton, Spinner, buttonClass, useToast } from '../components/ui';
import { HoldSummary } from '../features/checkout/HoldSummary';
import { MockPayForm } from '../features/checkout/MockPayForm';
import { OrderEnded } from '../features/checkout/OrderEnded';
import { useHold, useOrder, useReleaseHold } from '../features/checkout/queries';
import { usePayment } from '../features/checkout/usePayment';
import { LoadError } from '../features/events/LoadError';
import { seatsQueryKey } from '../hooks/useSeatSnapshot';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { createServerClock, useCountdown } from '../lib/serverClock';

const URGENT_MS = 60_000;

export default function Checkout() {
  const { holdId = '' } = useParams();
  const hold = useHold(holdId);

  if (hold.isPending) return <CheckoutSkeleton />;
  if (hold.isLoadingError) {
    return (
      <LoadError
        error={hold.error}
        onRetry={() => void hold.refetch()}
        title="Could not load your checkout"
        notFoundTitle="Hold not found"
        notFoundBody="This checkout link is not yours, or it no longer exists."
      />
    );
  }
  const data = hold.data;
  if (data.status === 'converted' && data.orderId) return <Navigate to={`/orders/${data.orderId}`} replace />;
  if (data.orderId && (data.status === 'released' || data.status === 'expired')) {
    return <EndedCheckout hold={data} orderId={data.orderId} receivedAt={hold.dataUpdatedAt} />;
  }
  return <OpenCheckout hold={data} receivedAt={hold.dataUpdatedAt} />;
}

/** A hold that is still open, or one that ended with no order to explain it. */
function OpenCheckout({ hold, receivedAt }: { hold: Hold; receivedAt: number }) {
  if (hold.status === 'released') {
    return (
      <EmptyState
        icon={<Undo2 aria-hidden />}
        title="You released these seats"
        body="They went back on sale for everyone."
        action={<BackToMap hold={hold} />}
      />
    );
  }
  // Keyed by hold so a new hold starts a fresh payment (and a fresh order idempotency key).
  return <CheckoutView key={hold.id} hold={hold} receivedAt={receivedAt} />;
}

/**
 * A hold that ended after an order was placed for it: its order says what happened (released,
 * replaced, expired, or refunded because the seats went to someone else). An order still
 * pending, a payment that outlived the hold, keeps the usual view; useOrder polls it until it settles.
 */
function EndedCheckout({ hold, orderId, receivedAt }: { hold: Hold; orderId: string; receivedAt: number }) {
  const order = useOrder(orderId);
  if (order.isPending) return <CheckoutSkeleton />;
  if (order.data?.status === 'paid') return <Navigate to={`/orders/${orderId}`} replace />;
  if (order.data?.status === 'failed') return <OrderEnded reason={order.data.failureReason} eventSlug={hold.eventSlug} />;
  return <OpenCheckout hold={hold} receivedAt={receivedAt} />;
}

function BackToMap({ hold }: { hold: Hold }) {
  return (
    <Link to={`/events/${hold.eventSlug}`} className={buttonClass('primary')}>
      Back to the seat map
    </Link>
  );
}

function CheckoutView({ hold, receivedAt }: { hold: Hold; receivedAt: number }) {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const clock = useMemo(() => createServerClock(hold.serverTime, receivedAt), [hold.serverTime, receivedAt]);
  const { msLeft, done } = useCountdown(hold.expiresAt, clock);
  const payment = usePayment(hold);
  const release = useReleaseHold(hold);
  const [confirmRelease, setConfirmRelease] = useState(false);

  const { state } = payment;
  // A payment in flight. It is the only time the API refuses a release; a declined card leaves Release open.
  const busy = state.step === 'paying' || state.step === 'processing';

  if (state.step === 'failed') return <OrderEnded reason={state.reason} eventSlug={hold.eventSlug} />;
  // While a payment is in flight the clock may run out, but a payment that arrives late can
  // still sell the seats if nobody else took them, so we wait for its outcome instead.
  if ((done || hold.status === 'expired') && !busy && state.step !== 'slow') {
    return (
      <EmptyState
        icon={<Clock4 aria-hidden />}
        title="Your hold expired"
        body="The seats went back on sale. They may still be free: have another look."
        action={<BackToMap hold={hold} />}
      />
    );
  }

  const onRelease = () =>
    release.mutate(undefined, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: seatsQueryKey(hold.eventId) });
        toast.push({ tone: 'success', title: 'Seats released', body: 'They are back on sale.' });
        navigate(`/events/${hold.eventSlug}`);
      },
      onError: (error) => {
        setConfirmRelease(false);
        toast.push({ tone: 'danger', title: 'Could not release the seats', body: errorMessage(error) });
      },
    });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm font-semibold tracking-widest text-accent uppercase">Checkout</p>
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">Pay for your seats</h1>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="order-2 lg:order-1">
          <Card className="p-5 sm:p-6">
            {state.step === 'slow' ? (
              <div className="flex flex-col items-start gap-3">
                <Hourglass aria-hidden className="size-8 text-warning" />
                <h2 className="font-display text-xl font-semibold text-ink">MockPay has not answered yet</h2>
                <p className="text-muted">
                  Your payment may still go through. Check again in a moment, or look in My tickets later: you are never charged
                  twice.
                </p>
                <Button onClick={() => void payment.checkAgain()}>Check again</Button>
              </div>
            ) : (
              <MockPayForm
                amountPaise={hold.amountPaise}
                defaultName={user?.name ?? ''}
                busy={busy}
                error={state.step === 'ready' ? state.error : undefined}
                onPay={(card) => void payment.pay(card)}
              />
            )}
            {state.step === 'processing' && (
              <p className="mt-4 flex items-center gap-2 text-sm text-muted">
                <Spinner size="sm" /> Card accepted. Waiting for MockPay to confirm the payment…
              </p>
            )}
          </Card>
        </div>
        <div className="order-1 lg:sticky lg:top-20 lg:order-2">
          <HoldSummary
            hold={hold}
            clock={clock}
            urgent={msLeft < URGENT_MS}
            canRelease={!busy && !release.isPending}
            releaseHint={busy ? 'You can release the seats once this payment finishes.' : undefined}
            onRelease={() => setConfirmRelease(true)}
          />
        </div>
      </div>

      <Modal
        open={confirmRelease}
        onClose={() => setConfirmRelease(false)}
        title="Release these seats?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRelease(false)}>
              Keep them
            </Button>
            <Button variant="danger" loading={release.isPending} onClick={onRelease}>
              Release
            </Button>
          </>
        }
      >
        They go back on sale straight away, and someone else may pick them.
      </Modal>
    </div>
  );
}

function CheckoutSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <span role="status" className="sr-only">
        Loading your checkout
      </span>
      <Skeleton className="h-10 w-64" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Skeleton className="h-[30rem] rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    </div>
  );
}
