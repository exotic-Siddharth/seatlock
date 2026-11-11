import { useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from './cx';

export type InputProps = ComponentProps<'input'> & {
  label: ReactNode;
  /** Shown under the field, which is marked aria-invalid. */
  error?: string;
  hint?: ReactNode;
};

/** A labelled text field. `className` styles the wrapper. */
export function Input({ label, error, hint, id, className, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const noteId = `${inputId}-note`;
  const note = error ?? hint;

  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        className={cx(
          'h-10 rounded-lg border bg-surface px-3 text-ink placeholder:text-muted/70',
          'focus:outline-2 focus:outline-offset-1 focus:outline-accent',
          error ? 'border-danger' : 'border-line',
        )}
        {...rest}
      />
      {note && (
        <p id={noteId} className={cx('text-sm', error ? 'text-danger' : 'text-muted')}>
          {note}
        </p>
      )}
    </div>
  );
}
