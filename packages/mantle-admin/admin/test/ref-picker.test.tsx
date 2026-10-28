import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadLanguage } from "../src/app/i18n";
import { SchemaFields } from "../src/features/content/entry-edit-view";
import { RefOptionList, refLookupQueryOptions, refOptionsQueryOptions } from "../src/features/content/ref-picker";
import { isEmptyOperationOutput, OperationResult } from "../src/features/content/row-operations";
import type { Collection, EntryRow, JsonSchema } from "../src/lib/types";

beforeAll(() => loadLanguage("zh-TW"));
afterEach(() => vi.unstubAllGlobals());

const customers: Collection = {
  name: "customers", exportFields: [], title: "Customers", description: null, lifecycle: "operational", hasTranslations: false, localized: false,
  list: { primaryField: "name", columns: ["name"] },
};
const row = (id: string, name: string): EntryRow => ({ id, collection: "customers", locale: null, status: null, version: 1, title: null, updated_at: 0, translation_locales: [], data_preview: { name } });
const schema: JsonSchema = { type: "object", properties: { customerId: { type: "string", "x-mantle-ref": "customers" }, note: { type: "string" } } };

/** Answers the entries route like the server would: a list, a refusal or nothing. */
function stubEntries(answer: (url: URL) => { status: number; body: unknown }): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, "https://admin.test");
    seen.push(url.pathname + url.search);
    const { status, body } = answer(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return seen;
}

async function render(value: Record<string, unknown>, collections: Collection[]): Promise<string> {
  const client = new QueryClient();
  client.setQueryData(["collections"], collections);
  if (collections.some((item) => item.name === "customers")) {
    await client.prefetchQuery(refOptionsQueryOptions("customers", ""));
    if (typeof value["customerId"] === "string") await client.prefetchQuery(refLookupQueryOptions("customers", "id", value["customerId"]));
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SchemaFields schema={schema} value={value} path={[]} onChange={() => {}} language="en" canonical={null} collectionName="orders" mediaPurposes={[]} />
    </QueryClientProvider>,
  );
}

const textInputs = (html: string) => (html.match(/<input[^>]*type="text"/g) ?? []).length;

describe("relation picker for x-mantle-ref fields", () => {
  it("shows the referenced record's title in a listbox trigger instead of a text box", async () => {
    const seen = stubEntries((url) => url.searchParams.get("filter_field") === "id"
      ? { status: 200, body: { items: [row("c1", "Acme Corp")], next_cursor: null } }
      : { status: 200, body: { items: [row("c1", "Acme Corp"), row("c2", "Globex")], next_cursor: null } });
    const html = await render({ customerId: "c1" }, [customers]);
    // the list is read through the entries route with a small limit, the lookup by the referenced field
    expect(seen).toContain("/admin/api/entries?collection=customers&limit=20&sort=updatedAt&direction=desc");
    expect(seen).toContain("/admin/api/entries?collection=customers&filter_field=id&filter_value=c1&limit=1");
    expect(html).toMatch(/<button[^>]*aria-haspopup="listbox"[^>]*aria-label="Customer Id"[^>]*data-ref-picker="customers"/);
    expect(html).toContain("Acme Corp");
    // only the unrelated `note` field keeps a plain text input
    expect(textInputs(html)).toBe(1);
  });

  it("asks to choose when nothing is selected", async () => {
    stubEntries(() => ({ status: 200, body: { items: [], next_cursor: null } }));
    const html = await render({}, [customers]);
    expect(html).toContain("Choose from Customers…");
    expect(textInputs(html)).toBe(1);
  });

  it.each([403, 404])("keeps the text input when the caller cannot list the target (%i)", async (status) => {
    stubEntries(() => ({ status, body: { error: { code: status === 403 ? "AUTH_DENIED" : "NOT_FOUND", message: "no" } } }));
    const html = await render({ customerId: "c1" }, [customers]);
    expect(html).not.toContain("aria-haspopup=\"listbox\"");
    expect(html).toContain('value="c1"');
    expect(textInputs(html)).toBe(2);
  });

  it("keeps the text input when the target is not an Admin collection", async () => {
    const seen = stubEntries(() => ({ status: 200, body: { items: [], next_cursor: null } }));
    const html = await render({ customerId: "c1" }, []);
    expect(html).not.toContain("aria-haspopup=\"listbox\"");
    expect(textInputs(html)).toBe(2);
    expect(seen).toEqual([]);
  });

  it("lists candidates as options with their titles, marking the selected one", () => {
    const html = renderToStaticMarkup(
      <RefOptionList id="l" baseId="b" items={[row("c1", "Acme Corp"), row("c2", "Globex")]} active={1} selected="c1" field="id"
        collection={customers} language="en" label="Customer" status="ready" onHover={() => {}} onChoose={() => {}} />,
    );
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toMatch(/id="b-option-0" role="option" aria-selected="true"/);
    expect(html).toMatch(/id="b-option-1" role="option" aria-selected="false" data-active="true"/);
    expect(html).toContain("Globex");
    const empty = renderToStaticMarkup(<RefOptionList id="l" baseId="b" items={[]} active={0} selected="" field="id" collection={customers} language="zh-TW" label="Customer" status="ready" onHover={() => {}} onChoose={() => {}} />);
    expect(empty).toContain("沒有符合的資料。");
  });
});

describe("a ref picker in an operation bound to the parent (#1825)", () => {
  it("lists only the bound parent's children through the folded list's scope; other fields list the whole target", async () => {
    const seen = stubEntries(() => ({ status: 200, body: { items: [row("c1", "Acme Corp")], next_cursor: null } }));
    const scope = { field: "accountId", value: "a1" };
    const client = new QueryClient();
    client.setQueryData(["collections"], [customers]);
    await client.prefetchQuery(refOptionsQueryOptions("customers", "", scope));
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SchemaFields schema={schema} value={{}} path={[]} onChange={() => {}} language="en" canonical={null} collectionName="move-customer" mediaPurposes={[]} refScopes={{ customerId: scope }} />
      </QueryClientProvider>,
    );
    expect(seen).toEqual(["/admin/api/entries?collection=customers&limit=20&sort=updatedAt&direction=desc&scope_field=accountId&scope_value=a1"]);
    expect(html).toContain('data-ref-picker="customers"');
    expect(refOptionsQueryOptions("customers", "").queryKey).toEqual(["entries", "ref-options", "customers", ""]);
  });
});

describe("operation result details", () => {
  it.each([null, undefined, {}, { results: [] }, { results: [[], []] }])("shows no Details block for an empty result %#", (output) => {
    expect(isEmptyOperationOutput(output)).toBe(true);
    expect(renderToStaticMarkup(<OperationResult output={output} language="en" />)).toBe("");
  });

  it("keeps Details for a result with content", () => {
    expect(isEmptyOperationOutput({ results: [[{ id: "o1" }]] })).toBe(false);
    expect(isEmptyOperationOutput({ orderId: "o1" })).toBe(false);
    const html = renderToStaticMarkup(<OperationResult output={{ results: [[{ id: "o1" }]] }} language="en" />);
    expect(html).toContain("<details");
    expect(html).toContain("o1");
  });
});
