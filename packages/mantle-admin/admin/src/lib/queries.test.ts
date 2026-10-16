import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { invalidateAfterWrite } from "./after-write";
import { mergeRefTitles } from "../features/content/collection-view";
import { entriesQueryArgsFromSearch, entriesQuerySearchParams, entryLandingChildQueryOptions, pagedQueryOptions } from "./queries";
import type { EntryEditorPayload } from "./types";

test("collection navigation maps its filters to the first-page entries query", () => {
  expect(entriesQueryArgsFromSearch("posts", "?status=published&filter_field=kind&filter_value=news")).toMatchObject({
    collectionName: "posts",
    status: "published",
    filterField: "kind",
    filterValue: "news",
    searchTerm: "",
    sortField: "updatedAt",
    sortDirection: "desc",
  });
});

test("the entries list always starts at the first page and Load more sends the cursor", () => {
  const args = entriesQueryArgsFromSearch("notes", "?search=literal%25_&cursor=stale");
  expect(args).toMatchObject({ searchTerm: "literal%_" });
  expect(entriesQuerySearchParams(args).has("cursor")).toBe(false);
  expect(entriesQuerySearchParams(args, "cursor:a").get("cursor")).toBe("cursor:a");
});

test("entry landing prefetches the first folded child with the same scoped list key", () => {
  const payload = {
    collection: { name: "organizations" },
    entry: { id: "org-1" },
    related: [
      {
        collection: {
          name: "references",
          parent: null,
        },
        relationship: { kind: "field", childField: "organizationId", parentValue: "org-1" },
      },
      {
        collection: {
          name: "projects",
          parent: { collection: "organizations", parentField: "id", childField: "organizationId" },
        },
        relationship: { kind: "field", childField: "organizationId", parentValue: "org-1" },
      },
    ],
  } as EntryEditorPayload;

  expect(entryLandingChildQueryOptions(payload)?.queryKey).toEqual([
    "entries", "projects", "all", "", "no-filter", "no-value",
    "organizationId", "org-1", "updatedAt", "desc",
  ]);
});

test("list and editor consume server projections without relationship HTTP requests", async () => {
  const {vi} = await import("vitest");
  const {entriesQueryOptions, composeEntry} = await import("./queries");
  const {QueryClient} = await import("@tanstack/react-query");
  const payload = {collection:{name:"posts"},entry:{id:"one"},related:[{entries:[{id:"translated"}]}],parentEntryId:null,parentEntryTitle:null} as unknown as EntryEditorPayload;
  const fetch = vi.fn(async () => Response.json({items:[{id:"one",title:"Post",translation_locales:["ja"]}],next_cursor:null}));
  vi.stubGlobal("fetch",fetch);
  try {
    const result = (await new QueryClient().fetchInfiniteQuery(entriesQueryOptions({collectionName:"posts",searchTerm:"",sortField:"updatedAt",sortDirection:"desc"}))).pages[0]!;
    expect(result.items[0]).toMatchObject({title:"Post",translation_locales:["ja"]});
    expect(fetch).toHaveBeenCalledOnce();
    expect(await composeEntry(payload)).toBe(payload);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {vi.unstubAllGlobals();}
});

const rowsOf = (client: QueryClient, key: readonly unknown[]) => (client.getQueryData(key) as { pages: { rows: string[] }[] } | undefined)?.pages.flatMap(page => page.rows);

test("a write refetches every page of a list already loaded, so page two shows the update", async () => {
  const client = new QueryClient();
  let name = "old";
  const key = ["view", "orders", ""];
  const options = pagedQueryOptions(key, async (cursor) => cursor ? { rows: [`${name}-2`], next_cursor: null } : { rows: [`${name}-1`], next_cursor: "c2" });
  // the list on screen is an active observer, which is what an invalidation refetches
  const observer = new InfiniteQueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  await vi.waitFor(() => expect(rowsOf(client, key)).toEqual(["old-1"]));
  await observer.fetchNextPage();
  expect(rowsOf(client, key)).toEqual(["old-1", "old-2"]);
  name = "new";
  invalidateAfterWrite(client);
  await vi.waitFor(() => expect(rowsOf(client, key)).toEqual(["new-1", "new-2"]));
  unsubscribe();
  client.clear();
});

test("the referenced titles of every page loaded are kept, field by field", () => {
  const title = (id: string) => ({ collection: "authors", id, title: id });
  expect(mergeRefTitles([{ author: { a: title("a") } }, undefined, { author: { b: title("b") }, editor: { c: title("c") } }]))
    .toEqual({ author: { a: title("a"), b: title("b") }, editor: { c: title("c") } });
});
