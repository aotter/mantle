import { expect, test } from "vitest";
import { cursorPageHref, entriesQueryArgsFromSearch, entryLandingChildQueryOptions } from "./queries";
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

test("native entry paging sends only the latest cursor and Previous revisits the opaque URL stack",()=>{
  const query=new URLSearchParams({search:"literal%_",parent:"parent",direction:"asc"});
  expect(cursorPageHref("/admin/c/notes",query)).toBeUndefined();
  const second=new URL(cursorPageHref("/admin/c/notes",query,"cursor:a")!,"https://app.test");
  const third=new URL(cursorPageHref(second.pathname,second.searchParams,"cursor:b")!,second);
  expect(third.searchParams.getAll("cursor")).toEqual(["cursor:a","cursor:b"]);
  expect(entriesQueryArgsFromSearch("notes",third.searchParams)).toMatchObject({cursor:"cursor:b",cursorDirection:"forward",searchTerm:"literal%_"});
  const previous=new URL(cursorPageHref(third.pathname,third.searchParams)!,third);
  expect(previous.searchParams.getAll("cursor")).toEqual(["cursor:a"]);
  expect(previous.searchParams.get("parent")).toBe("parent");
  expect(previous.searchParams.get("cursor_direction")).toBeNull();
  const first=new URL(cursorPageHref(previous.pathname,previous.searchParams)!,previous);
  expect(first.searchParams.has("cursor")).toBe(false);
  expect(first.searchParams.get("search")).toBe("literal%_");
  expect(query.has("cursor")).toBe(false);
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
