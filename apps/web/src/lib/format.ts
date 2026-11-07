export { formatInr } from '@seatlock/shared';

// Dates follow the visitor's locale; numbers use Indian grouping to match the rupee amounts.
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const number = new Intl.NumberFormat('en-IN');

/** "7 Nov 2026, 6:30 pm" */
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
/** "Sat, 7 Nov 2026" */
export const formatDate = (iso: string) => date.format(new Date(iso));
/** "6:30 pm" */
export const formatTime = (iso: string) => time.format(new Date(iso));
/** 123456 -> "1,23,456" */
export const formatNumber = (n: number) => number.format(n);
