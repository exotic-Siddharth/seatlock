import type { RegisterInput, User } from '@seatlock/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { EmptyState, Spinner, buttonClass } from '../components/ui';
import { ApiError, api } from './api';

export const ME_QUERY_KEY = ['auth', 'me'] as const;

type AuthContextValue = {
  /** The signed-in user, or null for a guest. */
  user: User | null;
  /** True until the first /api/auth/me answer arrives. */
  loading: boolean;
  login(email: string, password: string): Promise<User>;
  register(input: RegisterInput): Promise<User>;
  /** One-click sign-in as the demo user. */
  demo(): Promise<User>;
  logout(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchMe(): Promise<User | null> {
  try {
    return (await api<{ user: User }>('/api/auth/me')).user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** Keeps the current user in the query cache under ME_QUERY_KEY. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMe, staleTime: Infinity });

  const value = useMemo<AuthContextValue>(() => {
    // Everything cached so far belongs to the previous user (or to a guest).
    const resetUserData = () => queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_QUERY_KEY[0] });

    const signIn = async (path: string, body?: unknown) => {
      const { user } = await api<{ user: User }>(path, { method: 'POST', body });
      resetUserData();
      queryClient.setQueryData(ME_QUERY_KEY, user);
      return user;
    };

    return {
      user: me.data ?? null,
      loading: me.isPending,
      login: (email, password) => signIn('/api/auth/login', { email, password }),
      register: (input) => signIn('/api/auth/register', input),
      demo: () => signIn('/api/auth/demo'),
      logout: async () => {
        await api('/api/auth/logout', { method: 'POST' });
        resetUserData();
        queryClient.setQueryData(ME_QUERY_KEY, null);
      },
    };
  }, [me.data, me.isPending, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/**
 * Route guard. A guest is sent to `/login?next=<where they were going>`; with role="admin"
 * a signed-in non-admin sees a notice instead. Renders `children`, or the nested routes.
 */
export function RequireAuth({ role, children }: { role?: 'admin'; children?: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" label="Checking your session" />
      </div>
    );
  }
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (role === 'admin' && user.role !== 'admin') {
    return (
      <EmptyState
        icon={<ShieldAlert aria-hidden />}
        title="Admins only"
        body="This page is for the box office team."
        action={
          <Link to="/" className={buttonClass('secondary')}>
            Back to events
          </Link>
        }
      />
    );
  }
  return children ?? <Outlet />;
}
