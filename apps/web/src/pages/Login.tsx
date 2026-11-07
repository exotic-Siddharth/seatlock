// Stub: lane W1 builds this page. RequireAuth sends guests here as /login?next=<path>;
// after signing in, navigate to `next` (if it is a same-site path starting with "/") or to "/".
export default function Login() {
  return <h1 className="font-display text-3xl font-bold">Log in</h1>;
}
