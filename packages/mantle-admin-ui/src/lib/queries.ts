import { api } from "./api";
import { navigationTools, type AdminToolCatalog } from "./admin-tools";
import type { AuthMethodInfo, DeveloperConsoleSnapshot, ListEntriesResult, StaffOperation, ViewManifestInfo } from "./types";

export const COLLECTION_PAGE_SIZE = 50;

export interface EntriesQueryArgs {
  collectionName: string;
  status?: string;
  searchTerm: string;
  filterField?: string;
  filterValue?: string;
  scopeField?: string;
  scopeValue?: string;
  sortField: string;
  sortDirection: "asc" | "desc";
  cursor?: string;
  cursorDirection: "forward" | "backward";
}

export function entriesQueryArgsFromSearch(
  collectionName: string,
  search: string | URLSearchParams,
): EntriesQueryArgs {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return {
    collectionName,
    status: params.get("status") ?? undefined,
    searchTerm: params.get("search")?.trim() ?? "",
    filterField: params.get("filter_field") ?? undefined,
    filterValue: params.get("filter_value") ?? undefined,
    sortField: params.get("sort") || "updatedAt",
    sortDirection: params.get("direction") === "asc" ? "asc" : "desc",
    cursor: params.get("cursor") || undefined,
    cursorDirection: params.get("cursor_direction") === "backward" ? "backward" : "forward",
  };
}

export function entriesQuerySearchParams(args: EntriesQueryArgs): URLSearchParams {
  const qs = new URLSearchParams({
    collection: args.collectionName,
    limit: String(COLLECTION_PAGE_SIZE),
    sort: args.sortField,
    direction: args.sortDirection,
  });
  if (args.status) qs.set("status", args.status);
  if (args.searchTerm) qs.set("search", args.searchTerm);
  if (args.filterField && args.filterValue) {
    qs.set("filter_field", args.filterField);
    qs.set("filter_value", args.filterValue);
  }
  if (args.scopeField && args.scopeValue) {
    qs.set("scope_field", args.scopeField);
    qs.set("scope_value", args.scopeValue);
  }
  if (args.cursor) qs.set("cursor", args.cursor);
  if (args.cursorDirection === "backward") qs.set("cursor_direction", "backward");
  return qs;
}

export function entriesQueryOptions(args: EntriesQueryArgs) {
  const queryKey = [
    "entries", args.collectionName, args.status ?? "all", args.searchTerm,
    args.filterField ?? "no-filter", args.filterValue ?? "no-value",
    args.scopeField ?? "no-scope-field", args.scopeValue ?? "no-scope-value",
    args.sortField, args.sortDirection, args.cursor ?? "first", args.cursorDirection,
  ] as const;
  return {
    queryKey,
    queryFn: () => {
      const qs = entriesQuerySearchParams(args);
      return api.get<ListEntriesResult>(`/entries?${qs.toString()}`);
    },
  };
}

export function withNavigationTools(catalog: AdminToolCatalog): AdminToolCatalog {
  const tools = [...catalog.tools, ...navigationTools];
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("Admin navigation tool name collision.");
  return { ...catalog, tools };
}

export function developerConsoleQueryOptions(): {
  queryKey: readonly ["developer-console"];
  queryFn: () => Promise<DeveloperConsoleSnapshot>;
} {
  return {
    queryKey: ["developer-console"] as const,
    queryFn: () => api.get<DeveloperConsoleSnapshot>("/developer-console"),
  };
}

export function adminWebMcpQueryOptions(): {
  queryKey: readonly ["admin-webmcp"];
  queryFn: () => Promise<AdminToolCatalog>;
} {
  return {
    queryKey: ["admin-webmcp"] as const,
    queryFn: async () => {
      const catalog = await api.get<AdminToolCatalog>("/webmcp");
      return withNavigationTools(catalog);
    },
  };
}

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

/** Keep every consumer of this query key on the same unwrapped shape. */
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

/** Shared options keep operation consumers on one cache entry. */
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
