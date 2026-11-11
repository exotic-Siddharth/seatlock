import { describe, expect, it } from 'vitest';
import { TEST_CARDS, cardOutcome, formatInr, luhnValid, rupeesToPaise } from '../src';

describe('formatInr', () => {
  it('formats whole rupees with Indian digit grouping', () => {
    expect(formatInr(499900)).toContain('4,999');
    expect(formatInr(12345600)).toContain('1,23,456');
  });

  it('keeps paise when the amount is not whole rupees', () => {
    expect(formatInr(249950)).toContain('2,499.50');
  });
});

describe('rupeesToPaise', () => {
  it('converts without floating-point drift', () => {
    expect(rupeesToPaise(4999)).toBe(499900);
    expect(rupeesToPaise(19.99)).toBe(1999);
  });
});

describe('luhnValid', () => {
  it('accepts valid numbers and rejects a wrong check digit', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
  });

  it('accepts every test card', () => {
    for (const card of Object.values(TEST_CARDS)) expect(luhnValid(card)).toBe(true);
  });

  it('rejects non-digits and implausible lengths', () => {
    expect(luhnValid('4242 4242 4242 4242')).toBe(false);
    expect(luhnValid('42')).toBe(false);
    expect(luhnValid('')).toBe(false);
  });
});

describe('cardOutcome', () => {
  it('maps the three test cards to their outcomes', () => {
    expect(cardOutcome(TEST_CARDS.success)).toBe('succeeded');
    expect(cardOutcome(TEST_CARDS.declined)).toBe('card_declined');
    expect(cardOutcome(TEST_CARDS.insufficient)).toBe('insufficient_funds');
  });

  it('lets any other valid card succeed', () => {
    expect(cardOutcome('5555555555554444')).toBe('succeeded');
  });
});
