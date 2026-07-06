import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { cn } from "../lib/utils";

/** Minimal success-toast stack (#444): the app has no toast/sonner
 *  dependency, and operations that close a modal on success (the
 *  row-action dialog in `row-operations.tsx`) leave nothing on screen
 *  to carry a "saved" state the way `MediaTile`'s save button does
 *  (`media.saved` label swap in `media-library-view.tsx`) — the modal
 *  is gone by the time the operator would look at it. Rather than add
 *  a dependency, this is a small self-contained context: a fixed-
 *  position stack in a corner, auto-dismissing after a few seconds.
 *  Callers only ever push success confirmations here — errors already
 *  have their own inline treatment (`ErrorBox` / `OperationErrorBox`). */

interface ToastEntry {
  id: number;
  message: string;
}

interface ToastContextValue {
  showToast: (message: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 3200;

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = React.useState<ToastEntry[]>([]);
  const nextId = React.useRef(0);

  const showToast = React.useCallback((message: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  const value = React.useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto flex items-center gap-2 rounded-lg border border-[var(--glass-border)] bg-background px-4 py-3 text-sm shadow-[var(--glass-shadow-lg)]",
              "animate-in slide-in-from-bottom-2 fade-in-0 duration-200",
            )}
          >
            <CheckCircle2 className="size-4 shrink-0 text-[color:var(--success)]" aria-hidden />
            <span className="text-foreground">{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast() must be used within <ToastProvider>.");
  return ctx;
}
