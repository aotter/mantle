import { expect, test } from "vitest";
import { entriesQueryArgsFromSearch } from "./queries";

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
