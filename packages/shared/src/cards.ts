/** MockPay test cards (spec §7.2). Any other Luhn-valid number succeeds. */
export const TEST_CARDS = {
  success: '4242424242424242',
  declined: '4000000000000002',
  insufficient: '4000000000009995',
} as const;

export type CardOutcome = 'succeeded' | 'card_declined' | 'insufficient_funds';

/** Luhn checksum over a string of 12 to 19 digits (no spaces). */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** What MockPay does with a card. Callers must check `luhnValid` first. */
export function cardOutcome(digits: string): CardOutcome {
  if (digits === TEST_CARDS.declined) return 'card_declined';
  if (digits === TEST_CARDS.insufficient) return 'insufficient_funds';
  return 'succeeded';
}
