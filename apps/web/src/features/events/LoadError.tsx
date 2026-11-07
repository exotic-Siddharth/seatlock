import { CloudOff, SearchX } from 'lucide-react';
import { Link } from 'react-router';
import { Button, EmptyState, buttonClass } from '../../components/ui';
import { ApiError, errorMessage } from '../../lib/api';

/**
 * The error state of a page's main query: "not found" for a 404, otherwise the error with a
 * retry button. Shared by the public pages.
 */
export function LoadError({
  error,
  onRetry,
  title,
  notFoundTitle,
  notFoundBody,
}: {
  error: unknown;
  onRetry(): void;
  title: string;
  notFoundTitle?: string;
  notFoundBody?: string;
}) {
  if (notFoundTitle && error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        icon={<SearchX aria-hidden />}
        title={notFoundTitle}
        body={notFoundBody}
        action={
          <Link to="/" className={buttonClass('secondary')}>
            Back to events
          </Link>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={<CloudOff aria-hidden />}
      title={title}
      body={errorMessage(error)}
      action={
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}
