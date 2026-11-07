import type { User } from '@seatlock/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider, ME_QUERY_KEY } from '../src/lib/auth';
import { createQueryClient } from '../src/lib/queryClient';

/**
 * Renders `ui` inside the app's providers with a MemoryRouter at `route`. `user` seeds the
 * signed-in user (no /api/auth/me request is made). Queries don't retry, so errors show at once.
 */
export function renderWithProviders(
  ui: ReactElement,
  { route = '/', user = null }: { route?: string; user?: User | null } = {},
) {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  client.setQueryData(ME_QUERY_KEY, user);
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <ToastProvider>
          <AuthProvider>{ui}</AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, ...result };
}
