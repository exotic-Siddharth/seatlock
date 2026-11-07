import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';
import { ME_QUERY_KEY } from './auth';

const isClientError = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500;

export function createQueryClient(): QueryClient {
  // A 401 from any call means the session ended (expired, or logged out elsewhere).
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) client.setQueryData(ME_QUERY_KEY, null);
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: false,
        // 4xx answers won't change on retry; network blips and 5xx might.
        retry: (failureCount, error) => !isClientError(error) && failureCount < 2,
      },
    },
  });
  return client;
}

export const queryClient = createQueryClient();
