import type { SessionUser } from '../auth/sessions';

declare global {
  namespace Express {
    interface Request {
      /** Set by `loadSession` on every request: the signed-in user, or null. */
      user: SessionUser | null;
      /** How the user authenticated; only cookie-authenticated mutations are CSRF-checked. */
      authVia: 'cookie' | 'bearer' | null;
    }
  }
}

export {};
