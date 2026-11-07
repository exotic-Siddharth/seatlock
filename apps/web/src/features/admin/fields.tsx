import { useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from '../../components/ui';

const FIELD =
  'rounded-lg border bg-surface px-3 text-ink focus:outline-2 focus:outline-offset-1 focus:outline-accent';

type FieldProps = { label: ReactNode; error?: string; hint?: ReactNode; className?: string };

function Field({ label, error, hint, className, id, children }: FieldProps & { id: string; children: ReactNode }) {
  const note = error ?? hint;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {note && (
        <p id={`${id}-note`} className={cx('text-sm', error ? 'text-danger' : 'text-muted')}>
          {note}
        </p>
      )}
    </div>
  );
}

export function Select({ label, error, hint, className, ...rest }: FieldProps & ComponentProps<'select'>) {
  const id = useId();
  return (
    <Field id={id} label={label} error={error} hint={hint} className={className}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ?? hint ? `${id}-note` : undefined}
        className={cx(FIELD, 'h-10', error ? 'border-danger' : 'border-line')}
        {...rest}
      />
    </Field>
  );
}

export function Textarea({ label, error, hint, className, ...rest }: FieldProps & ComponentProps<'textarea'>) {
  const id = useId();
  return (
    <Field id={id} label={label} error={error} hint={hint} className={className}>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ?? hint ? `${id}-note` : undefined}
        className={cx(FIELD, 'min-h-24 py-2', error ? 'border-danger' : 'border-line')}
        {...rest}
      />
    </Field>
  );
}
