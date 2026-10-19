import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { CollectionView } from "../src/features/content/collection-view";
import { entriesQueryArgsFromSearch, entriesQueryOptions } from "../src/lib/queries";
import { ConfirmProvider } from "../src/ui/confirm-dialog";

it("lists the rows of every page loaded, titles referenced from a later page included, under one Load more", () => {
  const client = new QueryClient();
  const collection = {
    name: "orders", exportFields: [], title: "Orders", description: null, lifecycle: "operational", hasTranslations: false, localized: false,
    list: { primaryField: "customer", columns: ["customer"] },
    schema: { type: "object", properties: { customer: { type: "string" } } },
  };
  const row = (id: string, customer: string) => ({ id, collection: "orders", locale: null, status: null, version: 1, title: null, updated_at: 1, translation_locales: [], data_preview: { customer } });
  const title = (id: string, name: string) => ({ customer: { [id]: { collection: "customers", id, title: name } } });
  client.setQueryData(["collections"], [collection]);
  client.setQueryData(["site"], { title: "Site", description: "", locales: ["en"], canonicalLocale: "en" });
  client.setQueryData(["me"], { userId: "u", admin: true, login: null, image: null, role: "admin" });
  client.setQueryData(["operations"], []);
  const pages = [
    { items: [row("o1", "c1")], ref_titles: title("c1", "Acme"), next_cursor: "c2" },
    { items: [row("o2", "c2")], ref_titles: title("c2", "Beta"), next_cursor: null },
  ];
  const key = entriesQueryOptions(entriesQueryArgsFromSearch("orders", "")).queryKey;
  const render = (loaded: typeof pages) => {
    client.setQueryData(key, { pages: loaded, pageParams: loaded.map((_, i) => (i ? "c2" : undefined)) });
    return renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><AdminRouterProvider><ConfirmProvider><CollectionView collectionName="orders" /></ConfirmProvider></AdminRouterProvider></QueryClientProvider></PreferencesProvider>);
  };
  try {
    const both = render(pages);
    expect(both).toContain("Acme");
    // the title of a page-two row is that page's, not dropped
    expect(both).toContain("Beta");
    expect(both).not.toMatch(/Previous|Next/);
    expect(render([{ ...pages[0]!, next_cursor: "c2" }])).toContain(">Load more</button>");
    expect(both).not.toContain("Load more");
  } finally { client.clear(); }
});
