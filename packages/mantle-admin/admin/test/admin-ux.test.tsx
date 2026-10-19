import { describe, expect, it, vi, beforeAll, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { operationMatchesRow, OperationResult } from "../src/features/content/row-operations";
import { OperationDiagnostic } from "../src/features/ops/interaction-dialog";
import { DeveloperExplorer } from "../src/features/logic/developer-explorer";
import { AdminRouterProvider } from "../src/app/router";
import { TooltipProvider } from "@aotter/mantle-ui/kit";
import { fetchViewPreview, previewCollection, ViewDataPreview } from "../src/features/logic/live-data-preview";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PreferencesProvider } from "../src/app/preferences";
import type { Collection, AdminOperation, DeveloperViewModel, JsonSchema } from "../src/lib/types";
import { loadLanguage } from "../src/app/i18n";
import { optionLabel } from "../src/lib/enum-options";
import { renderDataValue, withNativeSchema } from "../src/lib/render-data-value";
import { propertyLabel } from "../src/lib/field-label";
import { api } from "../src/lib/api";
import { StatusBadge } from "../src/ui/status-badge";
const operation: AdminOperation = {name: "approve", title: null, description: null, input: {type: "object"}, uiSchema: null, triggers: ["mcp"], rowBindings: [], interactions: [], preconditions: [{field: "reqStatus", values: ["submitted", "reopened"]}]};
describe("acceptance Admin UX", () => {
  it.each(["internal", "public"] as const)("explains unavailable %s Views instead of displaying route errors", surface => {
    const model = {name: "unavailable", surface, query: {kind: "sql", statement: "SELECT id FROM records"}} as DeveloperViewModel;
    const client = new QueryClient();
    if (surface === "public") client.setQueryData(["developer-view-preview", model.name, {}, 0], {unavailable: true});
    const html = renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><ViewDataPreview model={model} /></QueryClientProvider></PreferencesProvider>);
    expect(html).toContain("Live data is unavailable"); expect(html).not.toContain("No such Admin route");
    client.clear();
  });
  it("hides mismatched equality and IN predicates, but leaves unknown fields and opaque actions available", () => {
    const row = {id: "r1", collection: "requisitions", data_preview: {reqStatus: "submitted", amount: 1}};
    expect(operationMatchesRow(operation, row)).toBe(true);
    expect(operationMatchesRow(operation, {...row, data: {reqStatus: "approved"}})).toBe(false);
    expect(operationMatchesRow(operation, {...row, data: {amount: "9007199254740993"}})).toBe(true);
    expect(operationMatchesRow(operation, {id: "r1", collection: "requisitions"})).toBe(true);
    expect(operationMatchesRow({...operation, preconditions: undefined}, row)).toBe(true);
  });
  it("keeps raw successful output in a closed native disclosure", () => {
    const html = renderToStaticMarkup(<OperationResult output={{results: [{reqStatus: "approved"}]}} language="en" />);
    expect(html).toContain("<details"); expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("Details"); expect(html).toContain("approved");
  });
  it("localizes conflicts and retains their technical diagnostic in Details", () => {
    const html = renderToStaticMarkup(<OperationDiagnostic diagnostic={{code: "CONFLICT", kind: "row", message: "No row matched this change."}} language="en" />);
    expect(html).toContain("The record changed"); expect(html).toContain("No row matched this change."); expect(html).toContain("<details>");
    const unique = renderToStaticMarkup(<OperationDiagnostic diagnostic={{code: "CONFLICT", kind: "unique", message: "A unique constraint of the Schema was violated."}} language="en" />);
    expect(unique).toContain("A record with the same unique value already exists.");
    expect(unique).not.toContain("The record changed");
    expect(renderToStaticMarkup(<OperationDiagnostic diagnostic={{code: "CONFLICT", message: "Publishing failed."}} language="en" />)).toBe("Publishing failed.");
    expect(renderToStaticMarkup(<OperationDiagnostic diagnostic={{code: "AUTH_DENIED", message: "Denied"}} language="en" />)).toBe("Denied");
  });
  it.each(["Model", "Logic"])("renders the shared %s explorer list and narrow drawer trigger", label => {
    const html = renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><TooltipProvider><AdminRouterProvider><DeveloperExplorer label={label} sidebarLabel="Objects" sidebar={<aside>first-object second-object</aside>} selectedId="Schema:first-object" graph={{atoms: [], relations: []}}><p>Definition</p></DeveloperExplorer></AdminRouterProvider></TooltipProvider></PreferencesProvider>);
    expect(html).toContain("first-object second-object");
    expect(html).toContain('aria-label="Objects"');
    expect(html).toContain("@container/explorer h-full w-full min-h-0 min-w-0");
    expect(html).toContain("@min-[42rem]/explorer:block");
    expect(html).toContain("@min-[42rem]/explorer:hidden");
  });
  it("finds folded collection routes and sends public View previews through the read-only developer route", async () => {
    const child = {name: "requisitions", parent: {collection: "vendors", parentField: "id", childField: "vendorId"}} as Collection;
    expect(previewCollection([child], "requisitions")).toBe(child);
    expect(previewCollection([child], "missing")).toBeUndefined();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({unavailable: true}));
    try { expect(await fetchViewPreview("my-requisitions", {limit: 20, q: "a & b"})).toEqual({unavailable: true}); expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/developer/views/my-requisitions?limit=20&q=a+%26+b"), expect.anything()); } finally { fetch.mockRestore(); }
  });
});

beforeAll(() => Promise.all([loadLanguage("zh-TW"), loadLanguage("ja")]));

const status: JsonSchema = { type: "string", oneOf: [{ const: "submitted", title: { en: "Submitted", "zh-TW": "已送出" } }, { const: "approved" }] };

describe("enum options", () => {

  it("labels an option by its title in the language, else humanizes the value", () => {
    expect(optionLabel(status, "submitted", "zh-TW")).toBe("已送出");
    expect(optionLabel(status, "approved", "zh-TW")).toBe("Approved");
    expect(renderToStaticMarkup(<>{renderDataValue(status, "submitted", "zh-TW")}</>)).toBe("已送出");
    expect(renderToStaticMarkup(<>{renderDataValue(status, "", "zh-TW")}</>)).toContain(">-<");
  });
});

describe("timestamps", () => {
  it("renders a date-time and the entry's own timestamps as a time, not the raw string", () => {
    const html = renderToStaticMarkup(<>{renderDataValue(withNativeSchema("createdAt", undefined), "2026-10-01T09:30:00.000000Z")}</>);
    expect(html).toMatch(/^<time dateTime="2026-10-01T09:30:00.000000Z">/);
    expect(withNativeSchema("title", undefined)).toBeUndefined();
  });
});

describe("labels and errors", () => {
  it("names the entry's own timestamps in the language", () => {
    expect(propertyLabel("createdAt", undefined, "zh-TW", null)).toBe("建立時間");
    expect(propertyLabel("updated_at", undefined, "en", null)).toBe("Updated");
  });

  it("reports the server's message, not the status line", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "SITE_NOT_CONFIGURED", message: "Site settings need the site tables." } }), { status: 501, statusText: "Not Implemented" }));
    try {
      await expect(api.get("/site-settings")).rejects.toThrow("Site settings need the site tables.");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
test("operational NULL status has no badge and inherited names remain literal text",()=>{
  const html=(status:string|null)=>renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><StatusBadge status={status}/></PreferencesProvider>);
  expect(html(null)).toBe("");
  for(const value of ["constructor","toString","__proto__"]){expect(html(value)).toContain(value);}
  expect(html("draft")).toContain("Draft");
});
test("a 4xx refusal says nothing changed and names the field; a 5xx keeps the generic failure", async () => {
  const { OperationErrorBox } = await import("../src/ui/page");
  const { ApiError } = await import("../src/lib/api");
  const render = (error: unknown) => renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><OperationErrorBox error={error} /></PreferencesProvider>);
  const refused = render(new ApiError("Value violates minimum.", 400, { error: { code: "INPUT_VALIDATION_FAILED", message: "Value violates minimum.", path: "schemas/products/admin/input/stock" } }));
  expect(refused).toContain("nothing was changed"); expect(refused).toContain("stock: Value violates minimum."); expect(refused).not.toContain("ran but failed");
  expect(render(new ApiError("500", 500, { error: { message: "boom" } }))).toContain("ran but failed");
  // request() appends the current version and what to do to a write conflict; the box keeps it.
  const conflict = new ApiError("The entry changed; reload it before writing.", 409, { error: { code: "CONFLICT", message: "The entry changed; reload it before writing." } });
  conflict.message += " The current version is v7. Reload and review your changes before trying again.";
  expect(render(conflict)).toContain("The current version is v7.");
});
