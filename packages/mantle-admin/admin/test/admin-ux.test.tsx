import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { operationMatchesRow, OperationResult } from "../src/features/content/row-operations";
import { OperationDiagnostic } from "../src/features/ops/interaction-dialog";
import { DeveloperExplorer } from "../src/features/logic/developer-explorer";
import { AdminRouterProvider } from "../src/app/router";
import { TooltipProvider } from "@aotter/mantle-ui/kit";
import { fetchViewPreview, previewCollection, ViewDataPreview } from "../src/features/logic/live-data-preview";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { globalOperations } from "../src/features/ops/operations-view";
import { buildNavGroups } from "../src/layout/authenticated-layout";
import { loadLanguage, STRINGS } from "../src/app/i18n";
import { ADMIN_LANGUAGES, PreferencesProvider } from "../src/app/preferences";
import type { Collection, AdminOperation, DeveloperViewModel } from "../src/lib/types";

const operation: AdminOperation = {name: "approve", title: null, description: null, input: {type: "object"}, uiSchema: null, triggers: ["mcp"], rowBindings: [], interactions: [], preconditions: [{field: "reqStatus", values: ["submitted", "reopened"]}]};
describe("acceptance Admin UX", () => {
  it("shows the Operations sidebar destination exactly when an unplaced admin action remains", () => {
    const actions: AdminOperation[] = [{...operation, interactions: [{collection: "requisitions", bind: [], mutates: true}]}, {...operation, name: "create", uiSchema: {collectionAction: "requisitions"}}, {...operation, name: "notify"}];
    expect(JSON.stringify(buildNavGroups([], [], "en", null, true, globalOperations(actions).length > 0))).toContain("/admin/operations");
    expect(JSON.stringify(buildNavGroups([], [], "en", null, true, globalOperations(actions.slice(0, 2)).length > 0))).not.toContain("/admin/operations");
  });
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
    const html = renderToStaticMarkup(<OperationDiagnostic diagnostic={{code: "CONFLICT", message: "Expected one affected row."}} language="en" />);
    expect(html).toContain("The record changed"); expect(html).toContain("Expected one affected row."); expect(html).toContain("<details>");
    const unique = renderToStaticMarkup(<OperationDiagnostic diagnostic={{code: "CONFLICT", message: "A unique constraint of the Schema was violated."}} language="en" />);
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
  it("provides all new messages in every retained locale", async () => {
    for (const { value: language } of ADMIN_LANGUAGES) {
      await loadLanguage(language);
      for (const key of ["ops.details", "ops.conditionConflict", "ops.uniqueConflict", "model.viewDataUnavailable"] as const) expect(STRINGS[language]?.[key]).toBeTruthy();
    }
  });
});
