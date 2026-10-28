import * as React from "react";
import { flushSync } from "react-dom";

export interface AdminLocation {
  pathname: string;
  search: string;
}

interface AdminRouterContextValue {
  location: AdminLocation;
  /** Resolves `true` once navigated; `false` when the person chose to stay. */
  navigate: (href: string, opts?: { replace?: boolean }) => Promise<boolean>;
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

/** The page a URL shows: a hash-only change stays on the page, so it never asks to leave. */
const pageOf = (url: { pathname: string; search: string }): string => `${url.pathname}${url.search}`;
const indexOf = (state: unknown): number | undefined => {
  const index = (state as { mantleIndex?: unknown } | null)?.mantleIndex;
  return typeof index === "number" ? index : undefined;
};

/**
 * Admin's in-app navigation, held while a page blocks leaving (#1792). A link or `navigate()` to another page first asks the
 * check; it resolves `true` once it navigated. Back/Forward has already moved when it is seen: every entry Admin writes carries
 * its index in `history.state`, so the move is undone by the same distance and, once confirmed, redone, leaving the history as
 * it was. A newer attempt supersedes one still asking. A reload or another site is the browser's own prompt (`useLeaveGuard`).
 */
export function createNavigator(win: Pick<Window, "location" | "history">, show: (location: AdminLocation) => void) {
  let check: LeaveCheck | null = null;
  let shown = pageOf(win.location);
  let index = 0;
  let redoTo: number | undefined;
  let attempt = 0;
  const show_ = (): void => {
    shown = pageOf(win.location);
    show({ pathname: win.location.pathname, search: win.location.search });
  };
  const go = (href: string, replace: boolean): void => {
    const url = new URL(href, win.location.href);
    const next = `${pageOf(url)}${url.hash}`;
    if (next !== `${pageOf(win.location)}${win.location.hash}`) {
      if (replace) win.history.replaceState({ mantleIndex: index }, "", next);
      else win.history.pushState({ mantleIndex: ++index }, "", next);
    }
    show_();
  };
  /** Asks, unless a newer attempt has started meanwhile: only the latest answer acts. */
  const confirmed = (ask: LeaveCheck): Promise<boolean> => {
    const mine = ++attempt;
    return ask().then((leave) => leave && mine === attempt, () => false);
  };
  return {
    /** Takes the current entry's index, or stamps it: before the first navigation, once mounted. */
    start(): void {
      const current = indexOf(win.history.state);
      if (current === undefined) win.history.replaceState({ mantleIndex: index }, "");
      else index = current;
    },
    block(next: LeaveCheck): () => void {
      check = next;
      return () => { if (check === next) check = null; };
    },
    navigate(href: string, opts: { replace?: boolean } = {}): Promise<boolean> {
      const ask = check;
      if (!ask || pageOf(new URL(href, win.location.href)) === shown) {
        attempt += 1;
        go(href, opts.replace ?? false);
        return Promise.resolve(true);
      }
      return confirmed(ask).then((leave) => {
        if (leave) go(href, opts.replace ?? false);
        return leave;
      });
    },
    popped(): void {
      const target = indexOf(win.history.state);
      // an entry the browser wrote itself (a same-page `#hash` link): take it as the next index
      if (target === undefined) {
        win.history.replaceState({ mantleIndex: ++index }, "");
        show_();
        return;
      }
      // the undo of a held move: back where the page already is
      if (target === index) return;
      const ask = check;
      if (!ask || target === redoTo || pageOf(win.location) === shown) {
        redoTo = undefined;
        index = target;
        show_();
        return;
      }
      const delta = target - index;
      win.history.go(-delta);
      void confirmed(ask).then((leave) => {
        if (!leave) return;
        redoTo = index + delta;
        win.history.go(delta);
      });
    },
  };
}

const serverNavigator = { start: () => {}, block: () => () => {}, navigate: () => Promise.resolve(false), popped: () => {} };

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
    navigator.start();
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
      // a same-page `#hash` link (the skip link) is the browser's own scroll
      const url = new URL(anchor.href);
      if (url.hash && pageOf(url) === pageOf(window.location)) return;

      event.preventDefault();
      void navigate(anchor.href);
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
