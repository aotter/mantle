import * as React from "react";
import { flushSync } from "react-dom";

export interface AdminLocation {
  pathname: string;
  search: string;
}

interface AdminRouterContextValue {
  location: AdminLocation;
  navigate: (href: string, opts?: { replace?: boolean }) => void;
  /** Asks `check` before Admin's own navigation leaves the page; returns the release. Internal (#1792). */
  block: (check: LeaveCheck) => () => void;
}

/** Asked before leaving a page with unsaved changes: `true` leaves. */
export type LeaveCheck = () => Promise<boolean>;

const AdminRouterContext = React.createContext<AdminRouterContextValue | null>(null);

function readLocation(): AdminLocation {
  if (typeof window === "undefined") return { pathname: "/admin", search: "" };
  return {
    pathname: window.location.pathname,
    search: window.location.search,
  };
}

function isSpaHref(href: string): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  if (!url.pathname.startsWith("/admin")) return false;
  if (url.pathname.startsWith("/admin/api/")) return false;
  if (url.pathname.startsWith("/admin/auth/")) return false;
  return true;
}

const pathOf = (url: { pathname: string; search: string; hash: string }): string => `${url.pathname}${url.search}${url.hash}`;

/**
 * Admin's in-app navigation, held while a page blocks leaving (#1792). A link or `navigate()` to another location first asks
 * the check. Back/Forward has already moved when it is seen, so the page's URL is put back and, once confirmed, the move is
 * redone. A reload or another site is the browser's own prompt (`useLeaveGuard`).
 */
export function createNavigator(win: Pick<Window, "location" | "history">, show: (location: AdminLocation) => void) {
  let check: LeaveCheck | null = null;
  let shown = pathOf(win.location);
  let redoing = false;
  const go = (href: string, replace: boolean): void => {
    const url = new URL(href, win.location.href);
    const next = pathOf(url);
    if (next !== pathOf(win.location)) {
      if (replace) win.history.replaceState(null, "", next);
      else win.history.pushState(null, "", next);
    }
    shown = next;
    show({ pathname: url.pathname, search: url.search });
  };
  return {
    block(next: LeaveCheck): () => void {
      check = next;
      return () => { if (check === next) check = null; };
    },
    navigate(href: string, opts: { replace?: boolean } = {}): void {
      const ask = check;
      if (!ask || pathOf(new URL(href, win.location.href)) === shown) return go(href, opts.replace ?? false);
      void ask().then((leave) => { if (leave) go(href, opts.replace ?? false); });
    },
    popped(): void {
      const ask = check;
      if (!ask || redoing || pathOf(win.location) === shown) {
        redoing = false;
        shown = pathOf(win.location);
        show({ pathname: win.location.pathname, search: win.location.search });
        return;
      }
      win.history.pushState(null, "", shown);
      void ask().then((leave) => {
        if (!leave) return;
        redoing = true;
        win.history.back();
      });
    },
  };
}

const serverNavigator = { block: () => () => {}, navigate: () => {}, popped: () => {} };

export function AdminRouterProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [location, setLocation] = React.useState<AdminLocation>(readLocation);
  const [navigator] = React.useState(() => typeof window === "undefined"
    ? serverNavigator
    : createNavigator(window, (next) => flushSync(() => setLocation(next))));
  const navigate = navigator.navigate;

  React.useEffect(() => {
    const onPopState = () => navigator.popped();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navigator]);

  React.useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      if (!isSpaHref(anchor.href)) return;

      event.preventDefault();
      navigate(anchor.href);
    };
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, [navigate]);

  const value = React.useMemo<AdminRouterContextValue>(
    () => ({ location, navigate, block: navigator.block }),
    [location, navigate, navigator],
  );

  return (
    <AdminRouterContext.Provider value={value}>
      {children}
    </AdminRouterContext.Provider>
  );
}

export function useAdminRouter(): AdminRouterContextValue {
  const ctx = React.useContext(AdminRouterContext);
  if (!ctx) {
    throw new Error("useAdminRouter must be used inside AdminRouterProvider.");
  }
  return ctx;
}

export function useAdminLocation(): AdminLocation {
  return useAdminRouter().location;
}

/**
 * While `active`, leaving the page asks first: Admin's own navigation through `ask`, a reload, closing the tab or another site
 * through the browser's own prompt (`beforeunload`). Internal: the record form's unsaved-changes guard (#1792).
 */
export function useLeaveGuard(active: boolean, ask: LeaveCheck): void {
  const { block } = useAdminRouter();
  const latest = React.useRef(ask);
  React.useEffect(() => { latest.current = ask; });
  React.useEffect(() => active ? guardLeaving(window, block, () => latest.current()) : undefined, [active, block]);
}

/** The guard `useLeaveGuard` holds while active; returns its release. */
export function guardLeaving(win: Pick<Window, "addEventListener" | "removeEventListener">, block: (check: LeaveCheck) => () => void, ask: LeaveCheck): () => void {
  const onBeforeUnload = (event: Event): void => {
    event.preventDefault();
    // older browsers show the prompt only when returnValue is set
    (event as BeforeUnloadEvent).returnValue = "";
  };
  win.addEventListener("beforeunload", onBeforeUnload);
  const release = block(ask);
  return () => {
    win.removeEventListener("beforeunload", onBeforeUnload);
    release();
  };
}
