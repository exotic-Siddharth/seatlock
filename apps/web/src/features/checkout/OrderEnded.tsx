import { CircleX, Clock4, Undo2 } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState, buttonClass } from '../../components/ui';
import { endedUnpaid, failureMessage, failureTitle } from './card';

/** An order that failed for good: what happened, whether money moved, and the way back to the seat map. */
export function OrderEnded({ reason, eventSlug }: { reason: string | null; eventSlug: string }) {
  const Icon = reason === 'HOLD_EXPIRED' ? Clock4 : endedUnpaid(reason) ? Undo2 : CircleX;
  return (
    <EmptyState
      icon={<Icon aria-hidden />}
      title={failureTitle(reason)}
      body={failureMessage(reason)}
      action={
        <Link to={`/events/${eventSlug}`} className={buttonClass('primary')}>
          Back to the seat map
        </Link>
      }
    />
  );
}
