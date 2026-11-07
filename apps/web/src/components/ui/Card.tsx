import type { ComponentProps } from 'react';
import { cx } from './cx';

/** A bordered surface. Padding is left to the caller. */
export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cx('rounded-2xl border border-line bg-surface shadow-sm', className)} {...rest} />;
}
