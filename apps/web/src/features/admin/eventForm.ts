import { CreateEventInputSchema, rupeesToPaise, type Category, type CreateEventInput, type Venue } from '@seatlock/shared';

/** What the create-event form holds: every field is the raw text the admin typed. */
export type EventFormValues = {
  title: string;
  subtitle: string;
  description?: string;
  category: Category;
  venueId: string;
  /** `datetime-local` value, e.g. "2027-03-20T19:30", in the admin's own time zone. */
  startsAt: string;
  saleOpensAt: string;
  /** Rupees per venue tier key. */
  prices: Record<string, string>;
  queueEnabled: boolean;
  admitRatePerSec: string;
};

/** Field name -> message. Price fields are keyed `price:<tierKey>`. */
export type EventFormErrors = Record<string, string>;

export type EventFormResult = { ok: true; input: CreateEventInput } | { ok: false; errors: EventFormErrors };

/** "2027-03-20T19:30" (local) -> ISO string, or null when it is not a date. */
function localToIso(value: string): string | null {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/** Validates the form and builds the API body. Prices become integer paise. */
export function toCreateEventInput(values: EventFormValues, venue: Venue | undefined): EventFormResult {
  const errors: EventFormErrors = {};

  const title = values.title.trim();
  if (!title) errors.title = 'Give the event a title';
  if (!venue) errors.venueId = 'Choose a venue';

  const startsAt = localToIso(values.startsAt);
  const saleOpensAt = localToIso(values.saleOpensAt);
  if (!startsAt) errors.startsAt = 'Pick when the event starts';
  if (!saleOpensAt) errors.saleOpensAt = 'Pick when ticket sales open';
  if (startsAt && saleOpensAt && Date.parse(saleOpensAt) >= Date.parse(startsAt)) {
    errors.saleOpensAt = 'The sale must open before the event starts';
  }

  const tierPrices: Record<string, number> = {};
  for (const tier of venue?.layout.tiers ?? []) {
    const rupees = Number(values.prices[tier.key]?.trim() || Number.NaN);
    if (!Number.isFinite(rupees) || rupeesToPaise(rupees) <= 0) {
      errors[`price:${tier.key}`] = `Enter a price for ${tier.name}`;
    } else {
      tierPrices[tier.key] = rupeesToPaise(rupees);
    }
  }

  const admitRate = Number(values.admitRatePerSec);
  if (values.queueEnabled && (!Number.isInteger(admitRate) || admitRate < 1 || admitRate > 10_000)) {
    errors.admitRatePerSec = 'Use a whole number from 1 to 10,000';
  }

  if (Object.keys(errors).length > 0 || !venue || !startsAt || !saleOpensAt) return { ok: false, errors };

  const parsed = CreateEventInputSchema.safeParse({
    title,
    subtitle: values.subtitle.trim() || undefined,
    description: values.description?.trim() || undefined,
    category: values.category,
    venueId: venue.id,
    startsAt,
    saleOpensAt,
    tierPrices,
    queueEnabled: values.queueEnabled,
    admitRatePerSec: values.queueEnabled ? admitRate : undefined,
  });
  if (!parsed.success) return { ok: false, errors: { form: parsed.error.issues[0]?.message ?? 'Check the form' } };
  return { ok: true, input: parsed.data };
}
