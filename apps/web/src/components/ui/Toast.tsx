import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from './cx';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';
export type ToastInput = { tone?: ToastTone; title: string; body?: string };
type Toast = Required<Pick<ToastInput, 'tone'>> & ToastInput & { id: number };

const VISIBLE_MS = 5_000;
const MAX_TOASTS = 4;

const TONE_STYLE: Record<ToastTone, { icon: typeof Info; className: string }> = {
  info: { icon: Info, className: 'text-info' },
  success: { icon: CircleCheck, className: 'text-success' },
  warning: { icon: TriangleAlert, className: 'text-warning' },
  danger: { icon: CircleAlert, className: 'text-danger' },
};

const ToastContext = createContext<{ push(toast: ToastInput): void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (toast: ToastInput) => {
      const id = ++nextId.current;
      setToasts((all) => [...all.slice(-(MAX_TOASTS - 1)), { tone: 'info', ...toast, id }]);
      setTimeout(() => dismiss(id), VISIBLE_MS);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((toast) => {
          const { icon: Icon, className } = TONE_STYLE[toast.tone];
          return (
            <div key={toast.id} className="pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-surface p-4 shadow-lg">
              <Icon aria-hidden className={cx('mt-0.5 size-5 shrink-0', className)} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{toast.title}</p>
                {toast.body && <p className="mt-0.5 text-sm text-muted">{toast.body}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
                className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** `useToast().push({ tone: 'success', title: 'Seats held' })` */
export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}
