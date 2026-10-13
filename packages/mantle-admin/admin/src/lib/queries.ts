import { api } from "./api";
import { queryClient } from "../app/query-client";
import { entryTitle } from "./entry-title";
import { mantleRefOf } from "./types";
import { navigationTools, type AdminToolCatalog } from "./admin-tools";
import { isFoldedFieldChild } from "./collection-nav";
import type { Collection, CollectionsMetadata, EntryDocument, EntryEditorCollection, EntryEditorEntry, EntryPage, EntryRow, RelatedEntrySection, AuthMethodInfo, DeveloperConsoleSnapshot, EntryEditorPayload, ListEntriesResult, SiteInfo, StaffOperation, ViewManifestInfo } from "./types";

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
  cursorDirection: "forward";
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
    cursor: params.getAll("cursor").slice(-1)[0] || undefined,
    cursorDirection: "forward",
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
  return qs;
}

/** Forward-only native paging; Previous revisits the preceding opaque cursor. */
export function cursorPageHref(path: string, query: URLSearchParams, nextCursor?: string): string | undefined {
  const cursors = query.getAll("cursor");
  if (!nextCursor && !cursors.length) return;
  const next = new URLSearchParams(query);
  next.delete("cursor");
  next.delete("cursor_direction");
  // ponytail: URL stacks grow with page depth; use session history if browser URL limits become material.
  for (const cursor of nextCursor ? [...cursors, nextCursor] : cursors.slice(0, -1)) next.append("cursor", cursor);
  const suffix = next.toString();
  return path + (suffix ? "?" + suffix : "");
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
    queryFn: async (): Promise<ListEntriesResult> => {
      const qs = entriesQuerySearchParams(args);
      const [page, metadata] = await Promise.all([api.get<EntryPage>(`/entries?${qs}`), collectionMetadata()]);
      const collection = metadata.allCollections[args.collectionName];
      if (!collection) throw new Error("Collection metadata is unavailable.");
      const locales = await translationLocales(collection, page.items, metadata);
      return { ...page, items: page.items.map(entry => entryRow(collection, entry, locales.get(entry.id) ?? [])) };
    },
  };
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

function editorCollection(collection: Collection): EntryEditorCollection {
  if (!collection.schema) throw new Error("Collection schema is unavailable.");
  return { ...collection, schema: collection.schema, uiSchema: collection.uiSchema ?? null, translates: collection.translates ?? null };
}

function valueOfEntry(entry: EntryEditorEntry, field: string): unknown {
  if (field === "id") return entry.id;
  if (field === "version") return entry.version;
  if (field === "status") return entry.status;
  if (field === "createdAt" || field === "created_at") return entry.created_at;
  if (field === "updatedAt" || field === "updated_at") return entry.updated_at;
  return entry.data[field];
}

function entryRow(collection: Collection, entry: EntryEditorEntry, locales: string[]): EntryRow {
  const properties = collection.schema?.properties ?? {};
  const primary = collection.list?.primaryField;
  const title = [primary, "title", "name", "slug", ...(collection.schema?.required ?? []).filter(field => [properties[field]?.type].flat().includes("string"))]
    .find(field => field && typeof entry.data[field] === "string" && entry.data[field] !== "");
  const preview = [...(primary ? [primary] : []), ...(collection.list?.columns ?? [])];
  return { ...entry, title: collection.lifecycle === "publishing" && title ? entry.data[title] : null,
    translation_locales: locales, ...(collection.lifecycle === "operational" && preview.length ? { data_preview: Object.fromEntries(preview.map(field => [field, valueOfEntry(entry, field) ?? null])) } : {}) };
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

async function translationLocales(collection: Collection, entries: readonly EntryEditorEntry[], metadata: CollectionsMetadata): Promise<Map<string, string[]>> {
  const result = new Map(entries.map(entry => [entry.id, new Set<string>()]));
  for (const child of Object.values(metadata.allCollections).filter(child => child.translates?.parent === collection.name && child.localized)) {
    const on = child.translates!.on;
    const keys = [...new Set(entries.map(entry => valueOfEntry(entry, on)).filter(scalar))];
    const byKey = new Map<unknown, Set<string>>();
    for (let offset = 0; offset < keys.length; offset += COLLECTION_PAGE_SIZE) {
      const params = new URLSearchParams({ collection: child.name, limit: "500", filter_field: on, filter_values: JSON.stringify(keys.slice(offset, offset + COLLECTION_PAGE_SIZE)) });
      for (;;) {
        const page = await api.get<EntryPage>(`/entries?${params}`);
        for (const entry of page.items) if (entry.locale) {
          const key = valueOfEntry(entry, on);
          byKey.set(key, (byKey.get(key) ?? new Set()).add(entry.locale));
        }
        if (!page.next_cursor) break;
        params.set("cursor", page.next_cursor);
      }
    }
    for (const entry of entries) for (const locale of byKey.get(valueOfEntry(entry, on)) ?? []) result.get(entry.id)!.add(locale);
  }
  return new Map([...result].map(([id, locales]) => [id, [...locales]]));
}

/** Compose only declared relationships using the same authorized paged entry API. */
export async function composeEntry(document: EntryDocument): Promise<EntryEditorPayload> {
  const { collection, entry } = document;
  const metadata = await collectionMetadata();
  const relationships = Object.values(metadata.allCollections).flatMap<{ collection: Collection; kind: "translation" | "field"; parentField: string; childField: string }>(child => {
    if (child.translates?.parent === collection.name || child.name === collection.name && child.translates) {
      return [{ collection: child, kind: "translation" as const, parentField: child.translates!.on, childField: child.translates!.on }];
    }
    return Object.entries(child.schema?.properties ?? {}).flatMap(([field, schema]) => {
      const ref = mantleRefOf(schema);
      return child.name !== collection.name && ref?.schema === collection.name
        ? [{ collection: child, kind: "field" as const, parentField: ref.field, childField: field }] : [];
    });
  });
  const valueOf = (field: string) => valueOfEntry(entry, field);
  const find = async (name: string, field: string, value: unknown, limit: number) => {
    if (!scalar(value) || value === "") return [];
    const params = new URLSearchParams({ collection: name, filter_field: field, filter_value: String(value), limit: String(limit) });
    return (await api.get<EntryPage>(`/entries?${params}`)).items;
  };
  const [parent, related] = await Promise.all([
    collection.parent ? find(collection.parent.collection, collection.parent.parentField, valueOf(collection.parent.childField), 1).then(rows => rows[0]) : undefined,
    Promise.all(relationships.map(async ({ collection: child, kind, parentField, childField }): Promise<RelatedEntrySection> => {
      const value = valueOf(parentField);
      const parentValue = scalar(value) && value !== "" ? value : null;
      return { collection: editorCollection(child), relationship: { kind, parentField, childField, parentValue }, entries: await find(child.name, childField, parentValue, COLLECTION_PAGE_SIZE) };
    })),
  ]);
  const parentCollection = collection.parent && metadata.allCollections[collection.parent.collection];
  return { collection, entry, parentEntryId: parent?.id ?? null,
    parentEntryTitle: parent && parentCollection ? entryTitle(parent.data, parent.id, parentCollection, parent.id) : null, related };
}

export function entryApiPath(collection: string, id: string, suffix = ""): string {
  return `/entries/${encodeURIComponent(id)}${suffix}?collection=${encodeURIComponent(collection)}`;
}

export function entryLandingChildQueryOptions(payload: EntryEditorPayload) {
  const child = payload.related.find((section) =>
    section.relationship.kind === "field" &&
    isFoldedFieldChild(section.collection, payload.collection.name, section.relationship.childField)
  );
  if (!child) return null;
  return entriesQueryOptions({
    ...entriesQueryArgsFromSearch(child.collection.name, ""),
    scopeField: child.relationship.childField,
    scopeValue: String(child.relationship.parentValue ?? payload.entry.id),
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

/** The deployment's site metadata and capabilities, shared by every page under one key. */
export function siteQueryOptions(): { queryKey: readonly ["site"]; queryFn: () => Promise<SiteInfo> } {
  return { queryKey: ["site"], queryFn: () => api.get<SiteInfo>("/site") };
}
