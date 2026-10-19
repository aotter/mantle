import { infiniteQueryOptions } from "@tanstack/react-query";
import { api } from "./api";
import { queryClient } from "../app/query-client";
import { navigationTools, type AdminToolCatalog } from "./admin-tools";
import { foldedChildScopeValue, isFoldedFieldChild } from "./collection-nav";
import type { CollectionsMetadata, EntryDocument, AuthMethodInfo, DeveloperConsoleSnapshot, EntryEditorPayload, ListEntriesResult, SiteInfo, AdminOperation, ViewManifestInfo } from "./types";
import { AUTH_BASE } from "./auth";

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
  };
}

export function entriesQuerySearchParams(args: EntriesQueryArgs, cursor?: string): URLSearchParams {
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
  if (cursor) qs.set("cursor", cursor);
  return qs;
}

/**
 * A cursor-paged list as one infinite query: the cursor is the page param, not state, so an invalidation
 * (`invalidateAfterWrite`) refetches every page loaded, and a page in flight never lands in another list.
 */
export function pagedQueryOptions<Page extends { next_cursor: string | null }>(queryKey: readonly unknown[], load: (cursor: string | undefined) => Promise<Page>) {
  return infiniteQueryOptions({
    queryKey,
    queryFn: ({ pageParam }) => load(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

export function entriesQueryOptions(args: EntriesQueryArgs) {
  return pagedQueryOptions([
    "entries", args.collectionName, args.status ?? "all", args.searchTerm,
    args.filterField ?? "no-filter", args.filterValue ?? "no-value",
    args.scopeField ?? "no-scope-field", args.scopeValue ?? "no-scope-value",
    args.sortField, args.sortDirection,
  ], (cursor) => api.get<ListEntriesResult>(`/entries?${entriesQuerySearchParams(args, cursor)}`));
}

export function entryEditorQueryOptions(collectionName: string, entryId: string) {
  return {
    queryKey: ["entry-editor", collectionName, entryId] as const,
    queryFn: async () => composeEntry(await api.get<EntryDocument>(entryApiPath(collectionName, entryId))),
  };
}

export function collectionMetadata(): Promise<CollectionsMetadata> {
  return queryClient.fetchQuery({
    queryKey: ["collection-metadata"],
    queryFn: () => api.get<CollectionsMetadata>("/collections"),
    staleTime: Infinity,
  });
}

/** The native server returns the complete editor projection on reads and writes. */
export async function composeEntry(document: EntryDocument): Promise<EntryEditorPayload> {
  return document as EntryEditorPayload;
}

export function entryApiPath(collection: string, id: string, suffix = ""): string {
  return `/entries/${encodeURIComponent(id)}${suffix}?collection=${encodeURIComponent(collection)}`;
}

export function entryLandingChildQueryOptions(payload: EntryEditorPayload) {
  const child = payload.related.find((section) =>
    section.relationship.kind === "field" &&
    isFoldedFieldChild(section.collection, payload.collection.name, section.relationship.childField)
  );
  const scopeValue = child ? foldedChildScopeValue(child.relationship) : null;
  if (!child || scopeValue === null) return null;
  return entriesQueryOptions({
    ...entriesQueryArgsFromSearch(child.collection.name, ""),
    scopeField: child.relationship.childField,
    scopeValue,
  });
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
      const res = await fetch(`${AUTH_BASE}/methods`, { credentials: "include" });
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
  queryFn: () => Promise<AdminOperation[]>;
} {
  return {
    queryKey: ["operations"] as const,
    queryFn: async () => {
      const res = await api.get<{ operations: AdminOperation[] }>("/operations");
      return res.operations;
    },
  };
}

/** The deployment's site metadata and capabilities, shared by every page under one key. */
export function siteQueryOptions(): { queryKey: readonly ["site"]; queryFn: () => Promise<SiteInfo> } {
  return { queryKey: ["site"], queryFn: () => api.get<SiteInfo>("/site") };
}
