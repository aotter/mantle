import { expect, test } from "vitest";
import { entriesQueryArgsFromSearch, entriesQuerySearchParams, entryLandingChildQueryOptions } from "./queries";
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
    cursorDirection: "forward",
  });
});

test("the entries list always starts at the first page and Load more sends the cursor", () => {
  const args = entriesQueryArgsFromSearch("notes", "?search=literal%25_&cursor=stale");
  expect(args).toMatchObject({ searchTerm: "literal%_", cursorDirection: "forward" });
  expect(entriesQuerySearchParams(args).has("cursor")).toBe(false);
  expect(entriesQuerySearchParams({ ...args, cursor: "cursor:a" }).get("cursor")).toBe("cursor:a");
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
    "organizationId", "org-1", "updatedAt", "desc", "first", "forward",
  ]);
});

test("list and editor consume server projections without relationship HTTP requests", async () => {
  const {vi} = await import("vitest");
  const {entriesQueryOptions, composeEntry} = await import("./queries");
  const payload = {collection:{name:"posts"},entry:{id:"one"},related:[{entries:[{id:"translated"}]}],parentEntryId:null,parentEntryTitle:null} as unknown as EntryEditorPayload;
  const fetch = vi.fn(async () => Response.json({items:[{id:"one",title:"Post",translation_locales:["ja"]}],next_cursor:null}));
  vi.stubGlobal("fetch",fetch);
  try {
    const result = await entriesQueryOptions({collectionName:"posts",searchTerm:"",sortField:"updatedAt",sortDirection:"desc",cursorDirection:"forward"}).queryFn();
    expect(result.items[0]).toMatchObject({title:"Post",translation_locales:["ja"]});
    expect(fetch).toHaveBeenCalledOnce();
    expect(await composeEntry(payload)).toBe(payload);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {vi.unstubAllGlobals();}
});
