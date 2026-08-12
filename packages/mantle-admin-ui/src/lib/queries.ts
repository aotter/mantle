import { api } from "./api";
import type { AuthMethodInfo, StaffOperation, ViewManifestInfo } from "./types";

export function authMethodsQueryOptions(): {
  queryKey: readonly ["auth-methods"];
  queryFn: () => Promise<AuthMethodInfo[]>;
  retry: false;
} {
  return {
    queryKey: ["auth-methods"] as const,
    queryFn: async () => {
      const res = await fetch("/api/auth/methods", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { methods?: AuthMethodInfo[] };
      return data.methods ?? [];
    },
    retry: false,
  };
}

/**
 * Shared react-query options for `GET /admin/api/views-manifest`
 * (#426, extended #443 with `title`). `authenticated-layout.tsx` and
 * `view-page.tsx` share the `["views-manifest"]` cache entry, so they
 * MUST agree on the cached shape — they previously declared different
 * queryFns under the same key (layout cached the unwrapped array,
 * view-page expected the `{ views }` envelope), and whichever mounted
 * first poisoned the other: SPA-navigating into a report page crashed
 * the whole tree on `undefined.find`, while a direct page load hid the
 * sidebar report group. One helper, one shape (the unwrapped array).
 */
export function viewsManifestQueryOptions(): {
  queryKey: readonly ["views-manifest"];
  queryFn: () => Promise<ViewManifestInfo[]>;
} {
  return {
    queryKey: ["views-manifest"] as const,
    queryFn: async () => {
      const res = await api.get<{ views: ViewManifestInfo[] }>("/views-manifest");
      return res.views;
    },
  };
}

/**
 * Shared react-query options for `GET /admin/api/operations` (#426,
 * extended #430 with `title`/`rowBindings`). Extracted once a third
 * call site needed the exact same `{ queryKey, queryFn }` pair
 * (`authenticated-layout.tsx`, `operations-view.tsx`,
 * `collection-view.tsx`) — same query key (`["operations"]`) as
 * before, so react-query still dedupes/caches across all three.
 */
export function operationsQueryOptions(): {
  queryKey: readonly ["operations"];
  queryFn: () => Promise<StaffOperation[]>;
} {
  return {
    queryKey: ["operations"] as const,
    queryFn: async () => {
      const res = await api.get<{ operations: StaffOperation[] }>("/operations");
      return res.operations;
    },
  };
}
