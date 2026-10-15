import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "..");

describe("@aotter/mantle-admin/app", () => {
  it("no longer exports the extension mechanism", () => {
    const exports = Object.keys(JSON.parse(readFileSync(resolve(pkg, "package.json"), "utf8")).exports);
    expect(exports).not.toContain("./extension");
    expect(exports).not.toContain("./server/extensions");
    expect(exports).toContain("./app");
  });

  it("publishes defineAdmin and MantleAdmin from the built library", async () => {
    const target = JSON.parse(readFileSync(resolve(pkg, "package.json"), "utf8")).exports["./app"];
    expect(target).toEqual({ types: "./dist/admin-app/index.d.ts", import: "./dist/admin-app/index.js" });
    const app = await import(resolve(pkg, target.import));
    expect(Object.keys(app).sort()).toEqual(["AdminLink", "MantleAdmin", "defineAdmin"]);
    expect(app.defineAdmin({})).toEqual({ meta: {}, pages: [], nav: { groups: {}, items: [] }, layers: {} });
    const page = (path: string) => ({ path, title: "T", element: null });
    expect(() => app.defineAdmin({}, { pages: [page("Budget")] })).toThrow("lowercase letters, digits and hyphens");
    expect(() => app.defineAdmin({}, { pages: [page("a/b")] })).toThrow("lowercase letters, digits and hyphens");
    expect(() => app.defineAdmin({}, { pages: [page("budget"), page("budget")] })).toThrow("two pages have the path 'budget'");
    expect(app.defineAdmin({}, { pages: [page("budget-2026")] }).pages).toHaveLength(1);
  });

  it("publishes the data hooks from a chunk shared with the app library, so both see one Admin context", async () => {
    const target = JSON.parse(readFileSync(resolve(pkg, "package.json"), "utf8")).exports["./hooks"];
    expect(target).toEqual({ types: "./dist/admin-app/hooks.d.ts", import: "./dist/admin-app/hooks.js" });
    const hooks = await import(resolve(pkg, target.import));
    expect(Object.keys(hooks).sort()).toEqual(["AdminUnavailableError", "createAdminHooks", "mcpAppTransport", "useAdminSurface", "useCollectionTotal", "useEntries", "useEntry", "useHost", "useMe", "useOpenLink", "useOperation", "useView"]);
    const context = (file: string) => /from"?\s*"\.\/(transport-[\w-]+\.js)"/.exec(readFileSync(resolve(pkg, "dist/admin-app", file), "utf8"))?.[1];
    const root = readFileSync(resolve(pkg, "dist/admin-app/index.js"), "utf8").match(/from\s*"\.\/(admin-root-[\w-]+\.js)"/)![1]!;
    expect(context("hooks.js")).toBeDefined();
    expect(context(root)).toBe(context("hooks.js"));
  });

  it("ships no prebuilt SPA: the application builds Admin", () => {
    const { exports } = JSON.parse(readFileSync(resolve(pkg, "package.json"), "utf8")) as { exports: Record<string, unknown> };
    expect(Object.keys(exports).filter(key => key.startsWith("./admin/"))).toEqual([]);
    expect(existsSync(resolve(pkg, "dist/admin"))).toBe(false);
  });

  it("types resolve for a NodeNext consumer", () => {
    const consumer = resolve(pkg, "test/__app-consumer.ts");
    const source = [
      'import { createAdminHooks, mcpAppTransport, type AdminHost } from "@aotter/mantle-admin/hooks";',
      "interface Types {",
      '  readonly views: { readonly "pending-requests": { readonly input: { readonly q?: string }; readonly row: { readonly id: string; readonly amount: number } } };',
      '  readonly collections: { readonly requests: { readonly data: { readonly title: string; readonly status: "open" | "closed" } } };',
      '  readonly operations: { readonly approve: { readonly input: { readonly id: string }; readonly output: { readonly ok: true } } };',
      "}",
      "const hooks = createAdminHooks<Types>();",
      "export function Component(): number {",
      '  const pending = hooks.useView("pending-requests", { q: "x" });',
      "  const amount: number | undefined = pending.rows[0]?.amount;",
      '  const entries = hooks.useEntries("requests", { filter: { field: "status", value: "open" } });',
      "  const title: string | undefined = entries.items[0]?.data.title;",
      '  const { run } = hooks.useOperation("approve");',
      '  void run?.({ id: "1" });',
      "  // @ts-expect-error a View name that is not in the manifest",
      '  hooks.useView("pending-request", {});',
      "  // @ts-expect-error an input the View does not declare",
      '  hooks.useView("pending-requests", { nope: 1 });',
      "  // @ts-expect-error a field the collection does not have",
      '  hooks.useEntries("requests", { filter: { field: "nope", value: "x" } });',
      "  // @ts-expect-error an operation input of the wrong type",
      '  void run?.({ id: 1 });',
      "  // @ts-expect-error a collection that is not in the manifest",
      '  hooks.useCollectionTotal("nope");',
      "  return (amount ?? 0) + (title ?? \"\").length + (pending.status === \"unavailable\" ? 1 : 0);",
      "}",
      "export const host: AdminHost | null = null;",
      "export const transport = mcpAppTransport;",
      'import { AdminLink, defineAdmin, MantleAdmin, type AdminDefinition, type AdminMeta, type MantleAdminProps, type SidebarProps } from "@aotter/mantle-admin/app";',
      "const admin: AdminDefinition = defineAdmin({});",
      "const typed: AdminMeta<Types> = {};",
      "export const composed: AdminDefinition = defineAdmin(typed, {",
      "  components: {",
      "    Sidebar: (props) => props.renderDefault({ ...props, footer: AdminLink({ href: \"https://example.com\", children: \"Help\" }) }),",
      '    "cell:requests.title": ({ value, surface }) => `${surface}:${value.length}`,',
      '    "cell:view:pending-requests.amount": ({ value, row }) => `${value + row.amount}`,',
      '    "input:requests.status": ({ value, onChange }) => { onChange(value === "open" ? "closed" : "open"); return null; },',
      '    "record.aside:requests": ({ entry }) => entry.data.title,',
      "  },",
      "  plugins: [{ components: { Home: (props) => props.renderDefault(props) } }],",
      "  mcp: { csp: { connectDomains: [\"https://api.example.com\"] } },",
      "});",
      "export const sidebar: SidebarProps | undefined = undefined;",
      '// @ts-expect-error a misspelt collection is not a slot',
      'defineAdmin(typed, { components: { "record.aside:request": () => null } });',
      '// @ts-expect-error a misspelt field is not a slot',
      'defineAdmin(typed, { components: { "cell:requests.titel": () => null } });',
      '// @ts-expect-error a browser slot has no `surface`',
      'defineAdmin(typed, { components: { Sidebar: ({ surface }) => String(surface) } });',
      "interface NavTypes extends Types {",
      '  readonly navGroups: "approvals" | "billing";',
      "}",
      "const navMeta: AdminMeta<NavTypes> = {};",
      "const Icon = (): null => null;",
      "export const navigation: AdminDefinition = defineAdmin(navMeta, { nav: {",
      '  groups: { approvals: { title: { en: "Approvals", "zh-TW": "簽核" }, order: 5 }, billing: { title: "Billing" } },',
      "  items: [",
      '    { group: "approvals", title: "Waiting for me", to: { view: "pending-requests", input: { q: "x" } } },',
      '    { group: "reports", title: "Closed", icon: Icon, order: 1, to: { collection: "requests", filter: { status: "closed" } } },',
      '    { group: "billing", title: "All", to: { collection: "requests" } },',
      "  ],",
      "} });",
      "export const withPage: AdminDefinition = defineAdmin(navMeta, { nav: { groups: { approvals: { title: \"A\" }, billing: { title: \"B\" } } }, pages: [{ path: \"budget\", title: \"Budget\", element: null, nav: { group: \"billing\", order: 1 } }, { path: \"plain\", title: \"Plain\", element: null }] });",
      '// @ts-expect-error a page is placed in a group the manifest or Admin has',
      'defineAdmin(navMeta, { nav: { groups: { approvals: { title: "A" }, billing: { title: "B" } } }, pages: [{ path: "x", title: "X", element: null, nav: { group: "billng" } }] });',
      "// a manifest that uses only Admin's groups needs no declaration; the config stays optional",
      "export const plain: AdminDefinition = defineAdmin(typed);",
      '// @ts-expect-error a group the manifest places items in is not declared',
      "defineAdmin(navMeta, { nav: { groups: {} } });",
      '// @ts-expect-error nav.groups is required while the manifest uses a group Admin does not have',
      "defineAdmin(navMeta, { nav: { items: [] } });",
      '// @ts-expect-error so is the config',
      "defineAdmin(navMeta);",
      '// @ts-expect-error a group title is text or a locale map',
      "defineAdmin(navMeta, { nav: { groups: { approvals: { title: 5 } } } });",
      "const declared = { nav: { groups: { approvals: { title: \"A\" }, billing: { title: \"B\" } } } } as const;",
      '// @ts-expect-error a collection that is not in the manifest',
      'defineAdmin(navMeta, { nav: { ...declared.nav, items: [{ group: "reports", title: "x", to: { collection: "request" } }] } });',
      '// @ts-expect-error a View that is not in the manifest',
      'defineAdmin(navMeta, { nav: { ...declared.nav, items: [{ group: "reports", title: "x", to: { view: "pending" } }] } });',
      '// @ts-expect-error an input the View does not declare',
      'defineAdmin(navMeta, { nav: { ...declared.nav, items: [{ group: "reports", title: "x", to: { view: "pending-requests", input: { q: 1 } } }] } });',
      '// @ts-expect-error a field the collection does not have',
      'defineAdmin(navMeta, { nav: { ...declared.nav, items: [{ group: "reports", title: "x", to: { collection: "requests", filter: { nope: "x" } } }] } });',
      '// @ts-expect-error a value the field cannot hold',
      'defineAdmin(navMeta, { nav: { ...declared.nav, items: [{ group: "reports", title: "x", to: { collection: "requests", filter: { status: "archived" } } }] } });',
      '// @ts-expect-error the list filters on one field: a second key would be dropped',
      'defineAdmin(navMeta, { nav: { ...declared.nav, items: [{ group: "reports", title: "x", to: { collection: "requests", filter: { status: "open", title: "late" } } }] } });',
      '// @ts-expect-error Admin\'s own groups are not redeclared',
      'defineAdmin(navMeta, { nav: { groups: { approvals: { title: "A" }, billing: { title: "B" }, more: { title: "Extras" } } } });',
      '// @ts-expect-error a group that neither Admin nor the manifest has',
      'defineAdmin(navMeta, { nav: { ...declared.nav, items: [{ group: "approval", title: "x", to: { collection: "requests" } }] } });',
      "const props: MantleAdminProps = { admin };",
      "// @ts-expect-error preview mode is internal to the canonical preview document",
      "export const preview: MantleAdminProps = { admin, preview: true };",
      "export const root = MantleAdmin(props);",
      "// @ts-expect-error metadata is required",
      "defineAdmin();",
    ].join("\n");
    const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, skipLibCheck: false, types: [] };
    const host = ts.createCompilerHost(options);
    const { getSourceFile, fileExists, readFile } = host;
    host.fileExists = file => file === consumer || fileExists(file);
    host.readFile = file => file === consumer ? source : readFile(file);
    host.getSourceFile = (file, language) => file === consumer ? ts.createSourceFile(file, source, language) : getSourceFile(file, language);
    const program = ts.createProgram([consumer], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });
});
