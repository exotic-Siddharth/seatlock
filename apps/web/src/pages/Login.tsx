import { LoginSchema } from '@seatlock/shared';
import { CircleAlert, Sparkles, Ticket } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Button, Input } from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

const isControlOrBackslash = (c: string) => c.charCodeAt(0) < 0x20 || c === '\u007f' || c === '\\';

/**
 * A path on this site: exactly one leading "/", and no control character or backslash, both
 * as written and once percent-decoded. Browsers read "\" as "/" and silently drop tab, CR and
 * LF, so "/\evil.example" and "/<tab>/evil.example" would otherwise become "//evil.example",
 * another host (React Router falls back to a full page load when pushState refuses it).
 */
function isSitePath(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false; // malformed percent-encoding
  }
  return [path, decoded].every((p) => p.startsWith('/') && !p.startsWith('//') && ![...p].some(isControlOrBackslash));
}

/** Where to go after signing in: `next` if it is a path on this site, else "/". */
export function safeNext(raw: string | null): string {
  if (!raw || !isSitePath(raw)) return '/';
  const url = new URL(raw, window.location.origin);
  const next = url.pathname + url.search + url.hash;
  // Checked again after normalising: resolving dot segments can itself produce "//host",
  // as in "/.//evil.example" or "/a/..//evil.example".
  return url.origin === window.location.origin && isSitePath(next) ? next : '/';
}

/** "?next=..." to carry the destination over to the other auth page. */
export const nextQuery = (raw: string | null) => (raw ? `?next=${encodeURIComponent(raw)}` : '');

/** The frame shared by the log-in and register pages: a ticket-stub panel and the form. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-4xl overflow-hidden rounded-3xl border border-line bg-surface shadow-sm md:grid-cols-[1fr_1.15fr]">
      <div aria-hidden className="relative hidden flex-col justify-between overflow-hidden bg-ink p-8 text-bg md:flex">
        <div className="absolute -bottom-24 -left-20 size-72 rounded-full bg-[radial-gradient(circle,var(--accent)_0,transparent_70%)] opacity-50" />
        <p className="relative inline-flex items-center gap-2 text-xs font-bold tracking-[0.3em] text-accent uppercase">
          <Ticket className="size-4 -rotate-12" /> Admit one
        </p>
        <p className="relative font-display text-4xl leading-none font-bold tracking-tight text-balance">Your seat is waiting.</p>
        <div className="relative flex items-end justify-between border-t-2 border-dashed border-bg/25 pt-4 text-xs opacity-70">
          <span>Live seat maps · fair waiting rooms</span>
          <span className="font-mono">SL-0000</span>
        </div>
      </div>
      <div className="flex flex-col gap-6 p-6 sm:p-10">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink">{title}</h1>
          <p className="mt-1 text-muted">{subtitle}</p>
        </div>
        {children}
        <p className="text-sm text-muted">{footer}</p>
      </div>
    </div>
  );
}

export function FormError({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/8 p-3 text-sm text-ink">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      {message}
    </p>
  );
}

export function DemoButton({ disabled }: { disabled?: boolean }) {
  const { demo } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onClick = async () => {
    setBusy(true);
    setError(null);
    try {
      await demo();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="secondary" size="lg" className="w-full" loading={busy} disabled={disabled} onClick={() => void onClick()}>
        <Sparkles aria-hidden className="size-4 text-accent" /> Try the demo
      </Button>
      {error && <FormError message={error} />}
    </>
  );
}

type Errors = { email?: string; password?: string; form?: string };

export default function Login() {
  const { user, login } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  // Signed in (just now, or already): go where the visitor was heading.
  if (user) return <Navigate to={safeNext(params.get('next'))} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = LoginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const fields = new Set(parsed.error.issues.map((i) => i.path[0]));
      setErrors({
        email: fields.has('email') ? 'Enter a valid email address' : undefined,
        password: fields.has('password') ? 'Enter your password' : undefined,
      });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await login(parsed.data.email, parsed.data.password);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      setErrors({
        form:
          code === 'INVALID_CREDENTIALS'
            ? 'That email and password do not match an account.'
            : code === 'RATE_LIMITED'
              ? 'Too many attempts. Wait a minute and try again.'
              : errorMessage(error),
      });
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Log in"
      subtitle="Welcome back. Your seats, tickets and place in line are under your account."
      footer={
        <>
          New here?{' '}
          <Link to={`/register${nextQuery(params.get('next'))}`} className="font-semibold text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="flex flex-col gap-4">
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        {errors.form && <FormError message={errors.form} />}
        <Button type="submit" size="lg" loading={busy} className="w-full">
          Log in
        </Button>
      </form>
      <div className="flex items-center gap-3 text-xs tracking-widest text-muted uppercase">
        <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
      </div>
      <DemoButton disabled={busy} />
    </AuthLayout>
  );
}
