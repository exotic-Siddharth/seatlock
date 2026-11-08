import type { CheckinResult } from '@seatlock/shared';
import { useMutation } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, CircleX, RotateCcw } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, Card, Input, cx } from '../../components/ui';
import { ApiError, api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

type Outcome =
  | { kind: 'result'; result: CheckinResult }
  /** The server looked and no ticket has this code (or it cannot be one): turn them away. */
  | { kind: 'invalid'; message: string }
  /** We could not ask (network, 5xx, expired session, rate limit...): says nothing about the ticket. */
  | { kind: 'error'; message: string };

/** Only a definite "no such ticket" is a verdict on the ticket; every other failure is ours. */
const isVerdict = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || error.code === 'VALIDATION_FAILED');

export default function AdminCheckin() {
  const [code, setCode] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const checkin = useMutation({
    mutationFn: (value: string) => api<CheckinResult>('/api/admin/checkin', { body: { code: value } }),
    onSuccess: (result) => {
      setOutcome({ kind: 'result', result });
      setCode('');
    },
    onError: (error) => {
      if (isVerdict(error)) {
        setOutcome({ kind: 'invalid', message: 'No ticket has that code.' });
        setCode('');
      } else {
        // Keep the code so staff can press Enter again once the problem clears.
        setOutcome({ kind: 'error', message: errorMessage(error) });
      }
    },
    onSettled: () => input.current?.focus(),
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
        {outcome?.kind === 'invalid' && (
          <Card className="flex flex-col items-center gap-2 border-danger p-8 text-center">
            <CircleX aria-hidden className="size-16 text-danger" />
            <p className="font-display text-2xl font-bold text-danger">Not valid</p>
            <p className="text-muted">{outcome.message}</p>
          </Card>
        )}
        {outcome?.kind === 'error' && (
          <Card className="flex flex-col items-center gap-2 p-8 text-center">
            <RotateCcw aria-hidden className="size-12 text-muted" />
            <p className="font-display text-2xl font-bold text-ink">Could not check, try again</p>
            <p className="text-muted">{outcome.message} The code is still in the box: press Enter to retry.</p>
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
