import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { prerender } from "react-dom/static";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemaFields } from "../src/features/content/entry-edit-view";
import { refLookupQueryOptions, refOptionsQueryOptions } from "../src/features/content/ref-picker";
import type { Collection, JsonSchema } from "../src/lib/types";

// Server rendering fires no events: Admin's own buttons, inputs and Markdown editor are stood in for by ones that keep
// their props, so a test calls the handler a person's clear would. The shared fields keep the kit's real controls.
const seen = vi.hoisted(() => [] as Record<string, any>[]);
vi.mock("@aotter/mantle-ui/kit", async (original) => ({
  ...(await original<typeof import("@aotter/mantle-ui/kit")>()),
  Button: (props: Record<string, any>) => { seen.push({ kind: "button", ...props }); return props["children"] ?? null; },
  Input: (props: Record<string, any>) => { seen.push({ kind: "input", ...props }); return null; },
}));
vi.mock("../src/features/editor/markdown-editor", () => ({
  MarkdownEditor: (props: Record<string, any>) => { seen.push({ kind: "markdown", ...props }); return null; },
}));
afterEach(() => vi.unstubAllGlobals());

const customers: Collection = {
  name: "customers", exportFields: [], title: "Customers", description: null, lifecycle: "operational", hasTranslations: false, localized: false,
  list: { primaryField: "name", columns: ["name"] },
};
const media = { type: "string", "x-mantle-ref": { schema: "media_assets", field: "id" } } as const;
const schema: JsonSchema = {
  type: "object",
  required: ["owner", "photo"],
  properties: {
    customerId: { type: "string", "x-mantle-ref": "customers" },
    owner: { type: "string", "x-mantle-ref": "customers" },
    cover: media,
    photo: media,
    body: { type: "string", "x-mcp-hint": "markdown" },
  },
};
const value = { customerId: "c1", owner: "c1", cover: "m1", photo: "m2", body: "# Hi" };

/** The record form (or, without `inputSlots`, a form that is not one) and the value its last change handed back. */
async function form(record = true) {
  seen.length = 0;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200, headers: { "content-type": "application/json" } }));
  const client = new QueryClient();
  client.setQueryData(["collections"], [customers]);
  client.setQueryData(refOptionsQueryOptions("customers", "").queryKey, { items: [], next_cursor: null });
  client.setQueryData(refLookupQueryOptions("customers", "id", "c1").queryKey, { items: [], next_cursor: null });
  let changed: Record<string, unknown> | undefined;
  const { prelude } = await prerender(
    <QueryClientProvider client={client}>
      <SchemaFields schema={schema} value={value} path={[]} onChange={(next) => { changed = next; }} language="en" canonical={null} collectionName="orders" mediaPurposes={[]}
        {...(record ? { inputSlots: { schema: "orders", readOnly: false } } : {})} />
    </QueryClientProvider>,
  );
  await new Response(prelude).text();
  return {
    clearRef: (label: string) => seen.find((p) => p.kind === "button" && p["aria-label"] === `Clear ${label}`),
    changed: () => changed!,
  };
}
const mediaBox = (id: string) => seen.find((p) => p.kind === "input" && p["value"] === id)!;

describe("the record form clears Admin's own controls to null", () => {
  it("a reference's clear button, never the empty string; a required reference has none", async () => {
    const f = await form();
    f.clearRef("Customer Id")!["onClick"]();
    expect(f.changed()).toHaveProperty("customerId", null);
    expect(f.clearRef("Owner")).toBeUndefined();
  });

  it("an emptied media id", async () => {
    const f = await form();
    mediaBox("m1")["onChange"]({ target: { value: "" } });
    expect(f.changed()).toHaveProperty("cover", null);
    // a required one is never "" either: it is left out, and the stored id stays
    mediaBox("m2")["onChange"]({ target: { value: "" } });
    expect(f.changed()).toHaveProperty("photo", undefined);
  });

  it("emptied Markdown", async () => {
    const f = await form();
    seen.find((p) => p.kind === "markdown")!["onChange"]("");
    expect(f.changed()).toHaveProperty("body", null);
  });
});

describe("a form that is not a record form (an operation's input)", () => {
  it("leaves a cleared reference or media id out, and keeps emptied text as the empty string", async () => {
    const f = await form(false);
    f.clearRef("Customer Id")!["onClick"]();
    expect(f.changed()).toHaveProperty("customerId", undefined);
    mediaBox("m1")["onChange"]({ target: { value: "" } });
    expect(f.changed()).toHaveProperty("cover", undefined);
    seen.find((p) => p.kind === "markdown")!["onChange"]("");
    expect(f.changed()).toHaveProperty("body", "");
  });
});
