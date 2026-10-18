import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { ParentEntryWorkbench } from "../src/features/content/parent-entry-workbench";
import { entryEditorQueryOptions, entryLandingChildQueryOptions } from "../src/lib/queries";
import type { EntryEditorPayload } from "../src/lib/types";

// order_lines.orderRef: { x-mantle-ref: { schema: orders, field: orderRef } }, folded by nav.parentField: orderRef
const orders = {
  name: "orders", exportFields: [], title: "Orders", description: null, lifecycle: "operational", hasTranslations: false, localized: false,
  list: { primaryField: "orderRef", columns: [] },
  schema: { type: "object", properties: { orderRef: { type: "string" } } },
};
const lines = {
  name: "order_lines", exportFields: [], title: "Lines", description: null, lifecycle: "operational", hasTranslations: false, localized: false,
  parent: { collection: "orders", parentField: "orderRef", childField: "orderRef" },
  translates: null,
  list: { primaryField: null, columns: [] },
  schema: { type: "object", properties: { orderRef: { type: "string", "x-mantle-ref": { schema: "orders", field: "orderRef" } }, sku: { type: "string" } } },
};

function payloadWith(orderRef: string | undefined): EntryEditorPayload {
  return {
    collection: orders,
    entry: { id: "o1", collection: "orders", locale: null, status: null, version: 1, data: orderRef === undefined ? {} : { orderRef } },
    parentEntryId: null,
    related: [{
      collection: lines,
      relationship: { kind: "field", parentField: "orderRef", childField: "orderRef", parentValue: orderRef ?? null },
      entries: [],
    }],
  } as unknown as EntryEditorPayload;
}

/** The scope the workbench's child list asks the server for, read from the queries it registers. */
function workbenchScopes(payload: EntryEditorPayload): unknown[][] {
  const client = new QueryClient();
  client.setQueryData(entryEditorQueryOptions("orders", "o1").queryKey, payload);
  client.setQueryData(["collections"], [orders, lines]);
  client.setQueryData(["site"], { title: "Site", description: "", locales: ["en"], canonicalLocale: "en" });
  client.setQueryData(["me"], { userId: "u", admin: true, login: null, image: null, role: "admin" });
  client.setQueryData(["operations"], []);
  renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><AdminRouterProvider><ParentEntryWorkbench collectionName="orders" entryId="o1" /></AdminRouterProvider></QueryClientProvider></PreferencesProvider>);
  return client.getQueryCache().findAll({ queryKey: ["entries", "order_lines"] }).map((query) => [...query.queryKey].slice(6, 8));
}

describe("a child folded by a unique-field reference", () => {
  it("lists the child by the parent's referenced field value, not its id", () => {
    expect(workbenchScopes(payloadWith("ORD-1"))).toEqual([["orderRef", "ORD-1"]]);
    expect(entryLandingChildQueryOptions(payloadWith("ORD-1"))?.queryKey.slice(6, 8)).toEqual(["orderRef", "ORD-1"]);
  });

  it("asks for nothing while the parent has no value for that field, rather than scoping by its id", () => {
    expect(workbenchScopes(payloadWith(undefined))).toEqual([]);
    expect(entryLandingChildQueryOptions(payloadWith(undefined))).toBeNull();
  });
});
