import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { loadLanguage } from "../src/app/i18n";
import { PreferencesProvider, type AdminLanguage } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { CollectionView } from "../src/features/content/collection-view";
import { canOpenForEdit, ParentEntryWorkbench } from "../src/features/content/parent-entry-workbench";
import { RecordOperations, RowOperationsMenu, splitRecordOperations } from "../src/features/content/row-operations";
import { entriesQueryArgsFromSearch, entriesQueryOptions, entryEditorQueryOptions } from "../src/lib/queries";
import type { AdminOperation, EntryEditorPayload } from "../src/lib/types";
import { ConfirmProvider } from "../src/ui/confirm-dialog";

beforeAll(() => loadLanguage("zh-TW"));

const operation = (name: string, title: string, extra: Partial<AdminOperation> = {}): AdminOperation => ({
  name,
  title,
  description: null,
  input: { type: "object", properties: { id: { type: "string" } } },
  uiSchema: null,
  triggers: ["mcp"],
  rowBindings: [],
  interactions: [{ collection: "requests", bind: [{ input: "id", field: "id" }], mutates: true }],
  ...extra,
});
const approve = operation("approve_request", "Approve", { preconditions: [{ field: "reqStatus", values: ["submitted"] }] });
const reject = operation("reject_request", "Reject", { preconditions: [{ field: "reqStatus", values: ["submitted"] }] });
const row = { id: "r1", collection: "requests", version: 2, data: { title: "Laptops", reqStatus: "submitted" } };

const requests = (readOnly: boolean) => ({
  name: "requests", exportFields: [], title: "Requests", description: null, lifecycle: "operational", hasTranslations: false, localized: false,
  list: { primaryField: "title", columns: ["title", "reqStatus"] },
  schema: { type: "object", ...(readOnly ? { readOnly: true } : {}), properties: { title: { type: "string" }, reqStatus: { type: "string" } } },
});
const lines = {
  name: "request_lines", exportFields: [], title: "Lines", description: null, lifecycle: "operational", hasTranslations: false, localized: false,
  parent: { collection: "requests", parentField: "id", childField: "requestId" },
  schema: { type: "object", properties: { requestId: { type: "string" } } },
};

function renderWorkbench({ readOnly, admin, operations }: { readOnly: boolean; admin: boolean; operations: AdminOperation[] }): string {
  const client = new QueryClient();
  const collection = requests(readOnly);
  const payload = {
    collection,
    entry: { id: "r1", collection: "requests", locale: null, status: null, version: 2, data: row.data },
    parentEntryId: null,
    related: [],
  } as unknown as EntryEditorPayload;
  client.setQueryData(entryEditorQueryOptions("requests", "r1").queryKey, payload);
  client.setQueryData(["collections"], [collection, lines]);
  client.setQueryData(["site"], { title: "Site", description: "", locales: ["en"], canonicalLocale: "en" });
  client.setQueryData(["me"], { userId: "u", admin, login: null, image: null, role: admin ? "admin" : "member" });
  client.setQueryData(["operations"], operations);
  return renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><AdminRouterProvider><ParentEntryWorkbench collectionName="requests" entryId="r1" /></AdminRouterProvider></QueryClientProvider></PreferencesProvider>);
}

const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(([, href, body]) => ({ href, text: body!.replace(/<[^>]+>/g, "") }));

describe("parent record workbench (read-only Schemas)", () => {
  it("offers View, never Edit, on a read-only Schema even to an admin", () => {
    const html = renderWorkbench({ readOnly: true, admin: true, operations: [] });
    expect(links(html)).toContainEqual({ href: "/admin/c/requests/r1/edit", text: "View" });
    expect(links(html).some(({ text }) => text === "Edit")).toBe(false);
  });

  it("offers Edit to an admin on a writable Schema and View to a non-admin", () => {
    expect(links(renderWorkbench({ readOnly: false, admin: true, operations: [] }))).toContainEqual({ href: "/admin/c/requests/r1/edit", text: "Edit" });
    const member = renderWorkbench({ readOnly: false, admin: false, operations: [] });
    expect(links(member)).toContainEqual({ href: "/admin/c/requests/r1/edit", text: "View" });
    expect(links(member).some(({ text }) => text === "Edit")).toBe(false);
  });

  it("shows the record's applicable operations as labeled buttons in the header", () => {
    const html = renderWorkbench({ readOnly: true, admin: true, operations: [approve, reject, operation("close_request", "Close", { preconditions: [{ field: "reqStatus", values: ["approved"] }] })] });
    expect(html).toMatch(/<button[^>]*>.*?Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*>.*?Reject<\/button>/);
    // an operation whose precondition the record does not meet is not offered
    expect(html).not.toContain("Close");
    expect(html).not.toContain("More actions");
  });

  it("follows the editor's rule for Edit versus View", () => {
    const payload = (readOnly: boolean, version: unknown = 1, lifecycle = "operational") =>
      ({ collection: { ...requests(readOnly), lifecycle }, entry: { version } }) as unknown as EntryEditorPayload;
    expect(canOpenForEdit(payload(false), true)).toBe(true);
    expect(canOpenForEdit(payload(false, 1, "publishing"), true)).toBe(true);
    expect(canOpenForEdit(payload(true), true)).toBe(false);
    expect(canOpenForEdit(payload(false), false)).toBe(false);
    expect(canOpenForEdit(payload(false), undefined)).toBe(false);
    expect(canOpenForEdit(payload(false, "9223372036854775807"), true)).toBe(false);
  });
});

describe("record operations", () => {
  const render = (operations: AdminOperation[], language: AdminLanguage = "en") => renderToStaticMarkup(
    <PreferencesProvider initialLanguage={language}><RecordOperations row={row} operations={operations} language={language} canonical={null} onSuccess={() => {}} /></PreferencesProvider>,
  );

  it("keeps up to three operations visible and moves the rest behind a labeled menu", () => {
    expect(splitRecordOperations([1, 2, 3])).toEqual({ inline: [1, 2, 3], overflow: [] });
    expect(splitRecordOperations([1, 2, 3, 4, 5])).toEqual({ inline: [1, 2], overflow: [3, 4, 5] });
    expect(splitRecordOperations([])).toEqual({ inline: [], overflow: [] });
  });

  it("labels the overflow menu in the language", () => {
    const many = ["a", "b", "c", "d"].map((name) => operation(name, name.toUpperCase()));
    const html = render(many);
    expect(html).toMatch(/<button[^>]*>.*?A<\/button>/);
    expect(html).toMatch(/<button[^>]*>.*?B<\/button>/);
    expect(html).toContain("More actions");
    expect(render(many, "zh-TW")).toContain("更多操作");
  });

  it("renders nothing without an applicable operation or link", () => {
    expect(render([])).toBe("");
  });
});

describe("list row actions", () => {
  it("names the compact trigger after the row it acts on", () => {
    const html = renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><RowOperationsMenu row={row} operations={[approve]} itemName="Laptops" language="en" canonical={null} onSuccess={() => {}} /></PreferencesProvider>);
    expect(html).toContain('aria-label="Actions for Laptops."');
    expect(html).toContain('title="Actions for Laptops."');
  });

  it("gives each list row an Actions trigger, and a read-only Schema a View link", () => {
    const client = new QueryClient();
    const collection = requests(true);
    client.setQueryData(["collections"], [collection]);
    client.setQueryData(["site"], { title: "Site", description: "", locales: ["en"], canonicalLocale: "en" });
    client.setQueryData(["me"], { userId: "u", admin: true, login: null, image: null, role: "admin" });
    client.setQueryData(["operations"], [approve]);
    const key = entriesQueryOptions(entriesQueryArgsFromSearch("requests", "")).queryKey;
    client.setQueryData(key, { pages: [{ items: [{ id: "r1", collection: "requests", locale: null, status: null, version: 2, title: null, updated_at: 1, translation_locales: [], data_preview: row.data }], next_cursor: null }], pageParams: [undefined] });
    const html = renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><AdminRouterProvider><ConfirmProvider><CollectionView collectionName="requests" /></ConfirmProvider></AdminRouterProvider></QueryClientProvider></PreferencesProvider>);
    expect(html).toContain('aria-label="Actions for Laptops."');
    expect(html).toContain('aria-label="View Laptops."');
    expect(html).not.toContain('aria-label="Edit Laptops."');
  });
});
