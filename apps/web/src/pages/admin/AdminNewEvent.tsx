import { EVENT_CATEGORIES, EVENT_DEFAULTS, type Venue } from '@seatlock/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Card, EmptyState, Input, Skeleton, buttonClass, useToast } from '../../components/ui';
import { toCreateEventInput, type EventFormErrors, type EventFormValues } from '../../features/admin/eventForm';
import { Select, Textarea } from '../../features/admin/fields';
import { api, errorMessage } from '../../lib/api';
import { formatNumber } from '../../lib/format';

const INITIAL: EventFormValues = {
  title: '',
  subtitle: '',
  description: '',
  category: 'music',
  venueId: '',
  startsAt: '',
  saleOpensAt: '',
  prices: {},
  queueEnabled: false,
  admitRatePerSec: String(EVENT_DEFAULTS.admitRatePerSec),
};

export default function AdminNewEvent() {
  const navigate = useNavigate();
  const toast = useToast();
  const [values, setValues] = useState<EventFormValues>(INITIAL);
  const [errors, setErrors] = useState<EventFormErrors>({});

  const venues = useQuery({
    queryKey: ['admin', 'venues'],
    queryFn: () => api<{ items: Venue[] }>('/api/admin/venues'),
    select: (data) => data.items,
  });
  const venue = venues.data?.find((v) => v.id === values.venueId);

  const create = useMutation({
    mutationFn: (body: unknown) => api<{ event: { id: string } }>('/api/admin/events', { body }),
    onSuccess: ({ event }) => {
      toast.push({ tone: 'success', title: 'Event created', body: 'Its seats are ready.' });
      navigate(`/admin/events/${event.id}`);
    },
    onError: (error) => toast.push({ tone: 'danger', title: 'Could not create the event', body: errorMessage(error) }),
  });

  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const result = toCreateEventInput(values, venue);
    setErrors(result.ok ? {} : result.errors);
    if (result.ok) create.mutate(result.input);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> All events
      </Link>
      <h1 className="mt-2 font-display text-3xl font-bold">Create an event</h1>
      <p className="mt-1 text-muted">Seats are created from the venue layout when you save.</p>

      {venues.isPending && <Skeleton className="mt-8 h-96 w-full" />}
      {venues.isError && (
        <EmptyState
          title="Could not load venues"
          body={errorMessage(venues.error)}
          action={<Button onClick={() => void venues.refetch()}>Try again</Button>}
        />
      )}

      {venues.isSuccess && (
        <form onSubmit={onSubmit} noValidate className="mt-8 flex flex-col gap-6">
          <Card className="grid gap-4 p-6 sm:grid-cols-2">
            <h2 className="font-display text-lg font-semibold sm:col-span-2">Basics</h2>
            <Input
              label="Title"
              value={values.title}
              onChange={(e) => set('title', e.target.value)}
              error={errors.title}
              maxLength={120}
              className="sm:col-span-2"
            />
            <Input
              label="Subtitle"
              value={values.subtitle}
              onChange={(e) => set('subtitle', e.target.value)}
              maxLength={160}
              className="sm:col-span-2"
            />
            <Select label="Category" value={values.category} onChange={(e) => set('category', e.target.value as EventFormValues['category'])}>
              {EVENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c[0]!.toUpperCase() + c.slice(1)}
                </option>
              ))}
            </Select>
            <Textarea
              label="Description"
              value={values.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
              maxLength={4000}
              className="sm:col-span-2"
            />
          </Card>

          <Card className="grid gap-4 p-6 sm:grid-cols-2">
            <h2 className="font-display text-lg font-semibold sm:col-span-2">Venue and prices</h2>
            <Select
              label="Venue"
              value={values.venueId}
              error={errors.venueId}
              onChange={(e) => setValues((c) => ({ ...c, venueId: e.target.value, prices: {} }))}
              className="sm:col-span-2"
            >
              <option value="">Choose a venue</option>
              {venues.data.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}, {v.city}
                </option>
              ))}
            </Select>
            {venue && (
              <>
                <p className="text-sm text-muted sm:col-span-2">
                  {formatNumber(venue.capacity)} seats &middot; tiers, most to least expensive:{' '}
                  {venue.layout.tiers.map((t) => t.name).join(', ')}
                </p>
                {venue.layout.tiers.map((tier) => (
                  <Input
                    key={tier.key}
                    label={`${tier.name} price (₹)`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={values.prices[tier.key] ?? ''}
                    onChange={(e) => set('prices', { ...values.prices, [tier.key]: e.target.value })}
                    error={errors[`price:${tier.key}`]}
                  />
                ))}
              </>
            )}
          </Card>

          <Card className="grid gap-4 p-6 sm:grid-cols-2">
            <h2 className="font-display text-lg font-semibold sm:col-span-2">Timing</h2>
            <Input
              label="Event starts"
              type="datetime-local"
              value={values.startsAt}
              onChange={(e) => set('startsAt', e.target.value)}
              error={errors.startsAt}
            />
            <Input
              label="Sale opens"
              type="datetime-local"
              value={values.saleOpensAt}
              onChange={(e) => set('saleOpensAt', e.target.value)}
              error={errors.saleOpensAt}
              hint="Both times are in your local time zone."
            />
          </Card>

          <Card className="grid gap-4 p-6 sm:grid-cols-2">
            <h2 className="font-display text-lg font-semibold sm:col-span-2">Waiting room</h2>
            <label className="flex items-start gap-3 sm:col-span-2">
              <input
                type="checkbox"
                checked={values.queueEnabled}
                onChange={(e) => set('queueEnabled', e.target.checked)}
                className="mt-1 size-4 accent-[var(--accent)]"
              />
              <span>
                <span className="font-medium">Use a waiting room for this sale</span>
                <span className="block text-sm text-muted">Buyers queue fairly and are let in at a fixed rate.</span>
              </span>
            </label>
            {values.queueEnabled && (
              <Input
                label="Admit rate (people per second)"
                type="number"
                min="1"
                max="10000"
                value={values.admitRatePerSec}
                onChange={(e) => set('admitRatePerSec', e.target.value)}
                error={errors.admitRatePerSec}
              />
            )}
          </Card>

          {errors.form && (
            <p role="alert" className="text-danger">
              {errors.form}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Link to="/admin" className={buttonClass('secondary')}>
              Cancel
            </Link>
            <Button type="submit" loading={create.isPending}>
              Create event
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
