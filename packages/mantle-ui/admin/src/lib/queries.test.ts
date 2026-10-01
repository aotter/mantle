import { expect, test } from "vitest";
import { entriesQueryArgsFromSearch, entryLandingChildQueryOptions } from "./queries";
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
