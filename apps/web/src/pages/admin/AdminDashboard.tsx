import type { Dashboard, OrderStatus } from '@seatlock/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RotateCcw, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Badge, Button, Card, EmptyState, Skeleton, useToast, type BadgeTone } from '../../components/ui';
import { ActionDialog } from '../../features/admin/ActionDialog';
import { Sparkline } from '../../features/admin/Sparkline';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, formatInr, formatNumber } from '../../lib/format';

const POLL_MS = 2_000;

const ORDER_TONE: Record<OrderStatus, { label: string; tone: BadgeTone }> = {
  paid: { label: 'Paid', tone: 'success' },
  pending_payment: { label: 'Pending', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
};

function StatTile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 font-display text-3xl font-bold tabular-nums">{value}</p>
      {note && <p className="mt-1 text-sm text-muted">{note}</p>}
    </Card>
  );
}

/** Available / held / sold as one proportional bar; the numbers above it carry the same information. */
function SeatBar({ counts }: { counts: Dashboard['counts'] }) {
  const share = (n: number) => `${counts.total === 0 ? 0 : (n / counts.total) * 100}%`;
  return (
    <div aria-hidden className="flex h-3 overflow-hidden rounded-full bg-surface-2">
      <div style={{ width: share(counts.sold), background: 'var(--accent)' }} />
      <div style={{ width: share(counts.held), background: 'var(--warning)' }} />
    </div>
  );
}

export default function AdminDashboard() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<'reopen' | 'crowd' | null>(null);

  const key = ['admin', 'dashboard', id] as const;
  const dashboard = useQuery({
    queryKey: key,
    queryFn: () => api<Dashboard>(`/api/admin/events/${id}/dashboard`),
    refetchInterval: POLL_MS,
  });

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown; done: string }) => api(`/api/admin/events/${id}/${path}`, { body }),
    onSuccess: (_data, { done }) => {
      toast.push({ tone: 'success', title: done });
      setDialog(null);
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => toast.push({ tone: 'danger', title: 'That did not work', body: errorMessage(error) }),
  });

  if (dashboard.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }
  if (dashboard.isError) {
    return (
      <EmptyState
        title="Could not load the dashboard"
        body={errorMessage(dashboard.error)}
        action={<Button onClick={() => void dashboard.refetch()}>Try again</Button>}
      />
    );
  }

  const d = dashboard.data;
  const peak = Math.max(0, ...d.holdsPerSecond);

  return (
    <div>
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> All events
      </Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">{d.event.title}</h1>
          <p className="mt-1 text-muted">
            {d.event.venue.name}, {d.event.venue.city} &middot; {formatDateTime(d.event.startsAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setDialog('reopen')}>
            <RotateCcw aria-hidden className="size-4" /> Reopen sale
          </Button>
          <Button variant="secondary" onClick={() => setDialog('crowd')}>
            <Users aria-hidden className="size-4" /> Simulate crowd
          </Button>
        </div>
      </div>

      <p className="mt-2 text-xs text-muted" aria-live="off">
        Updates every {POLL_MS / 1000} seconds.
      </p>

      <section aria-label="Key numbers" className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Available" value={formatNumber(d.counts.available)} note={`of ${formatNumber(d.counts.total)} seats`} />
        <StatTile label="Held" value={formatNumber(d.counts.held)} note={`${formatNumber(d.activeHolds)} active holds`} />
        <StatTile label="Sold" value={formatNumber(d.counts.sold)} />
        <StatTile label="Revenue" value={formatInr(d.revenuePaise)} note={`${formatNumber(d.ordersPaid)} paid orders`} />
      </section>
      <div className="mt-4">
        <SeatBar counts={d.counts} />
        <p className="mt-1 text-xs text-muted">
          <span className="text-accent">Sold</span> and <span className="text-warning">held</span> seats as a share of the venue.
        </p>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-lg font-semibold">Holds per second</h2>
            <p className="text-sm text-muted">last 60 s &middot; peak {formatNumber(peak)}</p>
          </div>
          <Sparkline values={d.holdsPerSecond} label="Holds per second over the last 60 seconds" />
        </Card>
        <Card className="p-4">
          <h2 className="font-display text-lg font-semibold">Waiting room</h2>
          {d.queue ? (
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div>
                <dd className="font-display text-2xl font-bold tabular-nums">{formatNumber(d.queue.length)}</dd>
                <dt className="text-xs text-muted">in line</dt>
              </div>
              <div>
                <dd className="font-display text-2xl font-bold tabular-nums">{formatNumber(d.queue.admitted)}</dd>
                <dt className="text-xs text-muted">admitted</dt>
              </div>
              <div>
                <dd className="font-display text-2xl font-bold tabular-nums">{formatNumber(d.queue.simulated)}</dd>
                <dt className="text-xs text-muted">simulated</dt>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-muted">This event does not use a waiting room.</p>
          )}
        </Card>
      </div>

      <Card className="mt-6 overflow-x-auto">
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 className="font-display text-lg font-semibold">Recent orders</h2>
          <p className="text-sm text-muted">
            {formatNumber(d.ordersPaid)} paid &middot; {formatNumber(d.ordersPending)} pending &middot; {formatNumber(d.ordersFailed)} failed
          </p>
        </div>
        {d.recentOrders.length === 0 ? (
          <p className="px-4 py-6 text-muted">No orders yet.</p>
        ) : (
          <table className="mt-2 w-full min-w-[34rem] text-sm">
            <caption className="sr-only">Recent orders</caption>
            <thead className="border-y border-line text-xs tracking-wide text-muted uppercase">
              <tr>
                <th scope="col" className="px-4 py-2 text-left font-semibold">Buyer</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Seats</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Amount</th>
                <th scope="col" className="px-4 py-2 text-left font-semibold">Status</th>
                <th scope="col" className="px-4 py-2 text-left font-semibold">Placed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.recentOrders.map((order) => {
                const status = ORDER_TONE[order.status];
                return (
                  <tr key={order.id}>
                    <th scope="row" className="px-4 py-2 text-left font-medium">{order.userName}</th>
                    <td className="px-4 py-2 text-right tabular-nums">{order.seats}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatInr(order.amountPaise)}</td>
                    <td className="px-4 py-2"><Badge tone={status.tone}>{status.label}</Badge></td>
                    <td className="px-4 py-2 whitespace-nowrap text-muted">{formatDateTime(order.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <ActionDialog
        open={dialog === 'reopen'}
        title="Reopen the sale?"
        description="Moves the sale opening to the delay below, counted from now, and clears the waiting room. Use it to re-run a flash-sale demo."
        label="Sale opens in (seconds)"
        initial={60}
        min={0}
        max={86_400}
        confirmLabel="Reopen sale"
        pending={act.isPending}
        onClose={() => setDialog(null)}
        onConfirm={(opensInSec) => act.mutate({ path: 'reopen-sale', body: { opensInSec }, done: 'Sale reopened' })}
      />
      <ActionDialog
        open={dialog === 'crowd'}
        title="Simulate a crowd?"
        description="Adds clearly labelled bot entries to the waiting room, so the queue looks busy. They are marked as simulated and never buy."
        label="Bots to add"
        initial={500}
        min={1}
        max={5000}
        confirmLabel="Add to queue"
        pending={act.isPending}
        onClose={() => setDialog(null)}
        onConfirm={(count) => act.mutate({ path: 'simulate-crowd', body: { count }, done: 'Crowd added to the waiting room' })}
      />
    </div>
  );
}
