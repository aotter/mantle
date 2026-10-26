import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { CollectionView } from "../src/features/content/collection-view";
import { entriesQueryArgsFromSearch, entriesQueryOptions } from "../src/lib/queries";
import { ConfirmProvider } from "../src/ui/confirm-dialog";

afterEach(() => vi.unstubAllGlobals());

function render(searchableFields: string[] | undefined, search = ""): string {
  const client = new QueryClient();
  const collection = {
    name: "people", exportFields: [], title: "People", description: null, lifecycle: "operational", hasTranslations: false, localized: false,
    list: { primaryField: "name", columns: [] }, ...(searchableFields ? { searchableFields } : {}),
    schema: { type: "object", properties: { name: { type: "string" } } },
  };
  if (search) vi.stubGlobal("window", { location: { pathname: "/admin/c/people", search, href: `http://x/admin/c/people${search}`, origin: "http://x" }, addEventListener() {}, removeEventListener() {} });
  client.setQueryData(["collections"], [collection]);
  client.setQueryData(["site"], { title: "Site", description: "", locales: ["en"], canonicalLocale: "en" });
  client.setQueryData(["me"], { userId: "u", admin: true, login: null, image: null, role: "admin" });
  client.setQueryData(["operations"], []);
  client.setQueryData(entriesQueryOptions(entriesQueryArgsFromSearch("people", search)).queryKey, { pages: [{ items: [], ref_titles: {}, next_cursor: null }], pageParams: [undefined] });
  try {
    return renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><AdminRouterProvider><ConfirmProvider><CollectionView collectionName="people" /></ConfirmProvider></AdminRouterProvider></QueryClientProvider></PreferencesProvider>);
  } finally { client.clear(); }
}

it("says the search box matches only the id when the collection declares no searchableFields", () => {
  expect(render([])).toContain('placeholder="Search by id..."');
  expect(render(["name"])).toContain('placeholder="Search id or searchable fields..."');
  // a descriptor that predates the field keeps the generic wording
  expect(render(undefined)).toContain('placeholder="Search id or searchable fields..."');
});

it("points an empty id-only search at searchableFields", () => {
  expect(render([], "?search=Ada")).toContain("This list searches by id only; declare searchableFields on the Schema");
  const searched = render(["name"], "?search=Ada");
  expect(searched).toContain("No entries matched “Ada”.");
  expect(searched).not.toContain("searchableFields");
});
