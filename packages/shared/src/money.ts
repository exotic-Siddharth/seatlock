const wholeRupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const withPaise = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
});

/** 499900 -> "₹4,999"; 249950 -> "₹2,499.50". Money is always integer paise. */
export function formatInr(paise: number): string {
  return paise % 100 === 0 ? wholeRupees.format(paise / 100) : withPaise.format(paise / 100);
}

/** 49.99 -> 4999, rounding away the floating-point error of `rupees * 100`. */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}
