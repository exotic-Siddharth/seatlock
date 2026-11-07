import type { CheckinResult } from '@seatlock/shared';
import { useMutation } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, CircleX } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, Card, Input, cx } from '../../components/ui';
import { ApiError, api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

type Outcome = { kind: 'result'; result: CheckinResult } | { kind: 'error'; message: string };

export default function AdminCheckin() {
  const [code, setCode] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const checkin = useMutation({
    mutationFn: (value: string) => api<CheckinResult>('/api/admin/checkin', { body: { code: value } }),
    onSuccess: (result) => setOutcome({ kind: 'result', result }),
    onError: (error) =>
      setOutcome({
        kind: 'error',
        message: error instanceof ApiError && error.status === 404 ? 'No ticket has that code.' : errorMessage(error),
      }),
    onSettled: () => {
      setCode('');
      input.current?.focus();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (value) checkin.mutate(value);
  };

  return (
    <div className="mx-auto max-w-xl">
      <Link to="/admin" className="text-sm text-muted hover:text-ink">
        All events
      </Link>
      <h1 className="mt-2 font-display text-3xl font-bold">Door check-in</h1>
      <p className="mt-1 text-muted">Scan or paste the code printed under the ticket QR, then press Enter.</p>

      <form onSubmit={onSubmit} className="mt-6 flex items-end gap-2">
        <Input
          ref={input}
          label="Ticket code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="flex-1"
        />
        <Button type="submit" loading={checkin.isPending} disabled={!code.trim()}>
          Check in
        </Button>
      </form>

      <div role="status" aria-live="polite" className="mt-8">
        {outcome?.kind === 'result' && <ResultPanel result={outcome.result} />}
        {outcome?.kind === 'error' && (
          <Card className="flex flex-col items-center gap-2 border-danger p-8 text-center">
            <CircleX aria-hidden className="size-16 text-danger" />
            <p className="font-display text-2xl font-bold text-danger">Not valid</p>
            <p className="text-muted">{outcome.message}</p>
          </Card>
        )}
      </div>
    </div>
  );
}

function ResultPanel({ result }: { result: CheckinResult }) {
  const repeat = result.alreadyCheckedIn;
  const Icon = repeat ? CircleAlert : CircleCheck;
  return (
    <Card className={cx('flex flex-col items-center gap-2 p-8 text-center', repeat ? 'border-warning' : 'border-success')}>
      <Icon aria-hidden className={cx('size-16', repeat ? 'text-warning' : 'text-success')} />
      <p className={cx('font-display text-3xl font-bold', repeat ? 'text-warning' : 'text-success')}>
        {repeat ? 'Already checked in' : 'Checked in'}
      </p>
      <p className="font-display text-2xl font-semibold">{result.seatLabel}</p>
      <p className="text-muted">{result.eventTitle}</p>
      {repeat && result.ticket.checkedInAt && (
        <p className="text-sm text-muted">First scanned {formatDateTime(result.ticket.checkedInAt)}. Do not let them in twice.</p>
      )}
    </Card>
  );
}
