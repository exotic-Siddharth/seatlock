import { Ticket } from 'lucide-react';
import { Suspense, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Skeleton, Spinner, buttonClass, cx, useToast } from '../ui';

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 font-display text-lg font-bold tracking-tight text-ink">
      <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-on-accent">
        <Ticket aria-hidden className="size-5 -rotate-12" />
      </span>
      Seatlock
    </Link>
  );
}

function AuthControls() {
  const { user, loading, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [leaving, setLeaving] = useState(false);

  if (loading) return <Skeleton className="h-8 w-28" />;

  if (!user) {
    return (
      <>
        <Link to="/login" className={buttonClass('ghost', 'sm')}>
          Log in
        </Link>
        <Link to="/register" className={buttonClass('primary', 'sm')}>
          Sign up
        </Link>
      </>
    );
  }

  const onLogout = async () => {
    setLeaving(true);
    try {
      await logout();
      navigate('/');
    } catch (error) {
      toast.push({ tone: 'danger', title: 'Could not log out', body: errorMessage(error) });
    } finally {
      setLeaving(false);
    }
  };

  return (
    <>
      <span className="hidden max-w-40 truncate text-sm text-muted sm:inline">{user.name}</span>
      <Button variant="ghost" size="sm" loading={leaving} onClick={onLogout}>
        Log out
      </Button>
    </>
  );
}

/** The layout route: header with nav and auth controls, the page, and a footer. */
export function AppShell() {
  const { user } = useAuth();
  const links = [
    { to: '/', label: 'Events', end: true },
    { to: '/tickets', label: 'My tickets' },
    { to: '/lab', label: 'Lab' },
    ...(user?.role === 'admin' ? [{ to: '/admin', label: 'Admin' }] : []),
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-accent px-4 py-2 text-on-accent focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Logo />
          <nav aria-label="Main" className="order-last -mx-1 flex w-full gap-1 overflow-x-auto sm:order-none sm:mx-0 sm:w-auto sm:flex-1">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) =>
                  cx(
                    'rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
                    isActive ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink',
                  )
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 sm:ml-0">
            <AuthControls />
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Suspense
          fallback={
            <div className="flex justify-center py-24">
              <Spinner size="lg" label="Loading page" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>A portfolio project. Every artist, venue and event is fictional, and no real money changes hands.</p>
          <Link to="/lab" className="font-medium text-ink hover:text-accent">
            How Seatlock never double-sells
          </Link>
        </div>
      </footer>
    </div>
  );
}
