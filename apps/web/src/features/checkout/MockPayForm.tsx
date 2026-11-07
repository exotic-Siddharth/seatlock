import { CircleAlert, CreditCard, FlaskConical, Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Input } from '../../components/ui';
import { formatInr } from '../../lib/format';
import { MOCKPAY_TEST_CARDS, cardErrors, formatCardNumber, formatExpiry, type CardErrors, type CardForm } from './card';

/** The MockPay card form, with a "Test mode" panel that fills in one of the test cards. */
export function MockPayForm({
  amountPaise,
  defaultName,
  busy,
  error,
  onPay,
}: {
  amountPaise: number;
  defaultName: string;
  busy: boolean;
  error?: string;
  onPay(card: CardForm): void;
}) {
  const [form, setForm] = useState<CardForm>({ cardNumber: '', expiry: '', cvc: '', name: defaultName });
  const [errors, setErrors] = useState<CardErrors>({});

  const set = (field: keyof CardForm, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const fillTestCard = (number: string) => {
    setForm((f) => ({ ...f, cardNumber: formatCardNumber(number), expiry: '12/34', cvc: '123', name: f.name || 'Test Fan' }));
    setErrors({});
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const found = cardErrors(form);
    setErrors(found);
    if (Object.keys(found).length === 0) onPay(form);
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5" aria-label="Pay with MockPay">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-display text-xl font-semibold text-ink">
          <CreditCard aria-hidden className="size-5 text-accent" /> Card details
        </h2>
        <span className="flex items-center gap-1 text-xs text-muted">
          <Lock aria-hidden className="size-3.5" /> MockPay
        </span>
      </div>

      <section aria-labelledby="test-mode" className="rounded-xl border border-dashed border-info/50 bg-info/6 p-4">
        <div className="flex items-center gap-2">
          <FlaskConical aria-hidden className="size-4 text-info" />
          <h3 id="test-mode" className="text-sm font-semibold text-ink">
            Test mode
          </h3>
          <span className="text-xs text-muted">No real money moves. Tap a card to use it.</span>
        </div>
        <ul className="mt-3 grid gap-2 sm:grid-cols-3">
          {MOCKPAY_TEST_CARDS.map((card) => (
            <li key={card.number}>
              <button
                type="button"
                disabled={busy}
                onClick={() => fillTestCard(card.number)}
                className="flex w-full flex-col items-start gap-1 rounded-lg border border-line bg-surface px-3 py-2 text-left transition hover:border-accent disabled:opacity-50"
              >
                <span className="font-mono text-xs text-ink">{formatCardNumber(card.number)}</span>
                <Badge tone={card.outcome === 'Succeeds' ? 'success' : 'danger'}>{card.outcome}</Badge>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <Input
          className="sm:col-span-2"
          label="Card number"
          inputMode="numeric"
          autoComplete="cc-number"
          placeholder="1234 1234 1234 1234"
          value={form.cardNumber}
          onChange={(e) => set('cardNumber', formatCardNumber(e.target.value))}
          error={errors.cardNumber}
        />
        <Input
          label="Expiry"
          inputMode="numeric"
          autoComplete="cc-exp"
          placeholder="MM/YY"
          value={form.expiry}
          onChange={(e) => set('expiry', formatExpiry(e.target.value))}
          error={errors.expiry}
        />
        <Input
          label="CVC"
          inputMode="numeric"
          autoComplete="cc-csc"
          placeholder="123"
          maxLength={4}
          value={form.cvc}
          onChange={(e) => set('cvc', e.target.value.replace(/\D/g, ''))}
          error={errors.cvc}
        />
        <Input
          className="sm:col-span-2"
          label="Name on card"
          autoComplete="cc-name"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          error={errors.name}
        />
      </fieldset>

      {error && !busy && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/8 p-4">
          <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
          <div>
            <p className="font-semibold text-ink">{error}</p>
            <p className="text-sm text-muted">Your seats are still held. Try again or use another card.</p>
          </div>
        </div>
      )}

      <Button type="submit" size="lg" loading={busy} className="w-full">
        {busy ? 'Processing…' : `Pay ${formatInr(amountPaise)}`}
      </Button>
    </form>
  );
}
