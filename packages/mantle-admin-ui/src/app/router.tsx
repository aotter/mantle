import * as React from "react";
import { flushSync } from "react-dom";

export interface AdminLocation {
  pathname: string;
  search: string;
}

interface AdminRouterContextValue {
  location: AdminLocation;
  navigate: (href: string, opts?: { replace?: boolean }) => void;
}

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

export function AdminRouterProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [location, setLocation] = React.useState<AdminLocation>(readLocation);

  const navigate = React.useCallback(
    (href: string, opts: { replace?: boolean } = {}) => {
      if (typeof window === "undefined") return;
      const url = new URL(href, window.location.href);
      const next = `${url.pathname}${url.search}${url.hash}`;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (next !== current) {
        if (opts.replace) window.history.replaceState(null, "", next);
        else window.history.pushState(null, "", next);
      }
      const nextLocation = { pathname: url.pathname, search: url.search };
      flushSync(() => setLocation(nextLocation));
    },
    [],
  );

  React.useEffect(() => {
    const onPopState = () => setLocation(readLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
    () => ({ location, navigate }),
    [location, navigate],
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
