import { randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O or U, so a code read aloud at the door can't be misheard.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `length` random Crockford base32 characters (5 bits each; 256 is a multiple of 32, so no bias). */
export function randomBase32(length: number): string {
  return [...randomBytes(length)].map((byte) => ALPHABET[byte % 32]).join('');
}

/** 'SL-' + 20 characters: 100 random bits, so codes can't be guessed. */
export const newTicketCode = () => `SL-${randomBase32(20)}`;
