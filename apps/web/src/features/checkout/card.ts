import { ConfirmPaymentSchema, TEST_CARDS } from '@seatlock/shared';

export type CardForm = { cardNumber: string; expiry: string; cvc: string; name: string };
export type CardErrors = Partial<Record<keyof CardForm, string>>;

export const MOCKPAY_TEST_CARDS = [
  { number: TEST_CARDS.success, outcome: 'Succeeds' },
  { number: TEST_CARDS.declined, outcome: 'Declined' },
  { number: TEST_CARDS.insufficient, outcome: 'Insufficient funds' },
] as const;

/** Digits only, at most 19, in groups of four: "4242 4242 4242 4242". */
export function formatCardNumber(input: string): string {
  return input
    .replace(/\D/g, '')
    .slice(0, 19)
    .replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** "1234" -> "12/34", as the user types. */
export function formatExpiry(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

const MESSAGES: Record<keyof CardForm, string> = {
  cardNumber: 'This card number is not valid',
  expiry: 'Use MM/YY',
  cvc: 'CVC is 3 or 4 digits',
  name: 'Enter the name on the card',
};

/** A card is good until the end of its expiry month. */
function hasExpired(expiry: string, now: Date): boolean {
  const [month, year] = expiry.split('/').map(Number);
  return now >= new Date(2000 + year!, month!, 1);
}

/** Field errors, checked with the same schema MockPay uses (Luhn included), plus expiry in the past. */
export function cardErrors(form: CardForm, now = new Date()): CardErrors {
  const errors: CardErrors = {};
  const result = ConfirmPaymentSchema.safeParse(form);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0] as keyof CardForm;
      errors[field] = MESSAGES[field];
    }
  }
  if (!errors.expiry && hasExpired(form.expiry, now)) errors.expiry = 'This card has expired';
  return errors;
}

/** What to tell the user about a declined attempt (the intent's failure code). */
export function declineMessage(code: string): string {
  if (code === 'card_declined') return 'Your card was declined.';
  if (code === 'insufficient_funds') return 'The card has insufficient funds.';
  return `The payment did not go through (${code}).`;
}

/** Why an order failed for good. */
export function failureMessage(reason: string | null): string {
  switch (reason) {
    case 'HOLD_LOST':
      return 'Your hold ran out before the payment arrived, and the seats went to someone else. The payment was refunded.';
    case 'SEAT_ALREADY_SOLD':
      return 'One of the seats was sold to someone else first. The payment was refunded.';
    case 'PAYMENT_DECLINED':
      return 'The payment was declined.';
    default:
      return reason ? `The order could not be completed (${reason}).` : 'The order could not be completed.';
  }
}
