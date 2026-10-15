import { test, expect } from "bun:test";
import { generateFromSources } from "../src/infrastructure/generate.js";
const schema = (name: string, nav?: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind: "Schema", metadata: { name }, spec: { title: name, lifecycle: "operational", ...(nav ? { uiSchema: { nav } } : {}), schema: { type: "object", readOnly: true, required: ["label"], properties: { label: { type: "string" } } } } });
const view = (name: string, nav?: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind: "View", metadata: { name }, spec: { surface: "admin", sql: "SELECT id, label FROM quotes ORDER BY id", ...(nav ? { uiSchema: { nav } } : {}) } });
const run = (docs: string[], navGroups?: unknown, adminExtensions: unknown[] = []) =>
  generateFromSources({ target: "bun-sqlite", admin: true, sources: { sources: [{ sourceId: "a.yaml", text: docs.join("\n---\n") }] }, navGroups: navGroups as never, adminExtensions: adminExtensions as never });
const codes = (r: Awaited<ReturnType<typeof run>>) => r.ok ? [] : r.diagnostics.map(d => `${d.code} ${d.path}`);

test("uiSchema.nav places Schemas and admin Views in built-in or declared groups; Admin metadata carries them", async () => {
  const ok = await run([schema("quotes", { group: "sales", order: 2 }), schema("audit", { hidden: true }), schema("customers", { group: "operations", order: 1 }), view("pipeline", { group: "sales", order: 1 })], [{ id: "sales", title: { en: "Sales", "zh-TW": "業務" }, order: 5 }]);
  if (!ok.ok) throw Error(JSON.stringify(ok.diagnostics));
  const metadata = ok.files["admin-descriptors.ts"]!;
  expect(metadata).toContain('export const navGroups = [{"id":"sales"');
  expect(metadata).toContain('"nav":{"group":"sales","order":1}');
  expect(metadata).toMatch(/export const bootstrap = \{[^}]*navGroups/);
});

test("generate refuses unknown groups, bad placement values and bad navGroups", async () => {
  expect(codes(await run([schema("quotes", { group: "sales" })]))).toEqual(["SCHEMA_UI_INVALID schemas/quotes/uiSchema/nav/group"]);
  expect(codes(await run([schema("quotes"), view("pipeline", { group: "sales" })]))).toEqual(["SCHEMA_UI_INVALID views/pipeline/uiSchema/nav/group"]);
  for (const nav of [{ order: 1.5 }, { hidden: "yes" }, { group: "Sales" }, { colour: "red" }]) expect((await run([schema("quotes", nav)])).ok).toBe(false);
  expect((await run([schema("quotes"), view("pipeline", { order: "1" })])).ok).toBe(false);
  expect(codes(await run([schema("quotes")], [{ id: "sales", title: "Sales" }, { id: "sales", title: "Again" }, { id: "content", title: "Mine" }, { id: "x", title: "" }]))).toEqual([
    "SCHEMA_UI_INVALID admin/navGroups/1/id", "SCHEMA_UI_INVALID admin/navGroups/2/id", "SCHEMA_UI_INVALID admin/navGroups/3/title"]);
  const page = (group: string) => [{ id: "tools", contributes: { pages: [{ id: "browser", title: "Browser", role: "admin", nav: { group } }] } }];
  expect(codes(await run([schema("quotes")], [], page("sales")))).toEqual(["UI_EXTENSION_INVALID admin/extensions/tools/pages/browser/nav/group"]);
  for (const group of ["more", "settings", "reports"]) expect((await run([schema("quotes")], [], page(group))).ok).toBe(true);
});

const doc = (name: string, spec: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind: "Schema", metadata: { name }, spec });
const child = (nav: object) => doc("lines", { title: "Lines", lifecycle: "operational", uiSchema: { nav }, schema: { type: "object", required: ["quoteId"], properties: { quoteId: { type: "string", "x-mantle-ref": "quotes" } } } });
const posts = doc("posts", { title: "Posts", lifecycle: "publishing", indexes: [["slug"]], schema: { type: "object", required: ["slug", "title"], properties: { slug: { type: "string" }, title: { type: "string" } } } });
const locales = (nav: object) => doc("postlocales", { title: "Post locales", lifecycle: "publishing", localized: true, translates: { parent: "posts", on: "slug" }, indexes: [["slug"]], uiSchema: { nav }, schema: { type: "object", required: ["slug", "locale", "title"], properties: { slug: { type: "string" }, locale: { type: "string" }, title: { type: "string" } } } });

test("generate refuses placement on a Schema with no sidebar entry of its own", async () => {
  expect(codes(await run([schema("quotes"), child({ group: "operations", hidden: true })]))).toEqual(["SCHEMA_UI_INVALID schemas/lines/uiSchema/nav/group", "SCHEMA_UI_INVALID schemas/lines/uiSchema/nav/hidden"]);
  const folded = await run([schema("quotes"), child({ order: 1 })]);
  expect(folded.ok ? "" : folded.diagnostics[0]!.message).toContain("nav.standalone: true");
  expect((await run([schema("quotes"), child({ standalone: true, group: "operations", order: 1 })])).ok).toBe(true);
  expect(codes(await run([posts, locales({ order: 1 })]))).toEqual(["SCHEMA_UI_INVALID schemas/postlocales/uiSchema/nav/order"]);
});

test("a child folded by a unique-field reference is not told to use standalone, which the checker refuses", async () => {
  const quotes = doc("quotes", { title: "Quotes", lifecycle: "operational", uniqueIndexes: [["code"]], schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } });
  const byCode = (nav: object) => doc("lines", { title: "Lines", lifecycle: "operational", uiSchema: { nav }, schema: { type: "object", required: ["quoteCode"], properties: { quoteCode: { type: "string", "x-mantle-ref": { schema: "quotes", field: "code" } } } } });
  const placed = await run([quotes, byCode({ order: 1 })]);
  expect(codes(placed)).toEqual(["SCHEMA_UI_INVALID schemas/lines/uiSchema/nav/order"]);
  const message = placed.ok ? "" : placed.diagnostics[0]!.message;
  expect(message).not.toContain("nav.standalone: true");
  expect(message).toContain("parent's workbench");
  expect((await run([quotes, byCode({ standalone: true })])).ok).toBe(false);
});

test("generate reports a non-object navGroups entry instead of throwing", async () => {
  expect(codes(await run([schema("quotes")], [null, 1]))).toEqual(["SCHEMA_UI_INVALID admin/navGroups/0", "SCHEMA_UI_INVALID admin/navGroups/1"]);
});

test("generate refuses a non-integer extension page order", async () => {
  for (const group of ["more", "settings"]) expect(codes(await run([schema("quotes")], [], [{ id: "tools", contributes: { pages: [{ id: "browser", title: "Browser", role: "admin", nav: { group, order: 1.5 } }] } }])))
    .toEqual(["UI_EXTENSION_INVALID admin/extensions/tools/pages/browser/nav/order"]);
});

test("generate refuses an extension page nav that is not an object with a string group", async () => {
  const page = (nav: unknown) => [{ id: "tools", contributes: { pages: [{ id: "browser", title: "Browser", role: "admin", nav }] } }];
  for (const nav of [{}, { order: 1 }, "more", null, [], { group: 1 }]) expect(codes(await run([schema("quotes")], [], page(nav)))).toEqual(["UI_EXTENSION_INVALID admin/extensions/tools/pages/browser/nav"]);
  expect((await run([schema("quotes")], [], page(undefined))).ok).toBe(true);
});

// #1667: two required id references are ambiguous; nav.parentField chooses the fold parent on its own
const twoRefs = (nav?: object, extra: object = {}) => doc("lines", { title: "Lines", lifecycle: "operational", ...(nav ? { uiSchema: { nav } } : {}), schema: { type: "object", required: ["quoteId", "customerId", ...Object.keys(extra)], properties: { quoteId: { type: "string", "x-mantle-ref": "quotes" }, customerId: { type: "string", "x-mantle-ref": "customers" }, ...extra } } });
const parentOf = (r: Awaited<ReturnType<typeof run>>) => {
  if (!r.ok) throw Error(JSON.stringify(r.diagnostics));
  return /"name":"lines".*?"parent":(\{[^}]*\})/.exec(r.files["admin-descriptors.ts"]!)?.[1];
};

test("generate refuses a Schema with two required id references and no nav.parentField, naming the line that keeps today's parent", async () => {
  const r = await run([schema("quotes"), schema("customers"), twoRefs()]);
  expect(codes(r)).toEqual(["SCHEMA_UI_INVALID /spec/uiSchema/nav/parentField"]);
  const message = r.ok ? "" : r.diagnostics[0]!.message;
  expect(message).toContain("Schema 'lines'");
  expect(message).toContain("quoteId, customerId");
  expect(message).toContain("nav: { parentField: quoteId }");
  // standalone without parentField gets the same diagnostic, with the line to add
  const standalone = await run([schema("quotes"), schema("customers"), twoRefs({ standalone: true })]);
  expect(codes(standalone)).toEqual(["SCHEMA_UI_INVALID /spec/uiSchema/nav/parentField"]);
  expect(standalone.ok ? "" : standalone.diagnostics[0]!.message).toContain("nav: { parentField: quoteId }");
});

test("nav.parentField without standalone chooses the fold parent; the Schema stays folded", async () => {
  expect(parentOf(await run([schema("quotes"), schema("customers"), twoRefs({ parentField: "customerId" })]))).toBe('{"collection":"customers","parentField":"id","childField":"customerId"}');
  expect(parentOf(await run([schema("quotes"), schema("customers"), twoRefs({ parentField: "quoteId" })]))).toBe('{"collection":"quotes","parentField":"id","childField":"quoteId"}');
  // still folded: no sidebar entry of its own to place
  expect(codes(await run([schema("quotes"), schema("customers"), twoRefs({ parentField: "customerId", order: 1 })]))).toEqual(["SCHEMA_UI_INVALID schemas/lines/uiSchema/nav/order"]);
  expect((await run([schema("quotes"), schema("customers"), twoRefs({ standalone: true, parentField: "customerId", group: "operations" })])).ok).toBe(true);
});

test("one id reference plus a unique-field reference is not ambiguous, and parentField may pick the unique-field one", async () => {
  const quotes = doc("quotes", { title: "Quotes", lifecycle: "operational", uniqueIndexes: [["code"]], schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } });
  const lines = (nav?: object) => doc("lines", { title: "Lines", lifecycle: "operational", ...(nav ? { uiSchema: { nav } } : {}), schema: { type: "object", required: ["quoteCode", "customerId"], properties: { quoteCode: { type: "string", "x-mantle-ref": { schema: "quotes", field: "code" } }, customerId: { type: "string", "x-mantle-ref": "customers" } } } });
  expect(parentOf(await run([quotes, schema("customers"), lines()]))).toBe('{"collection":"customers","parentField":"id","childField":"customerId"}');
  expect(parentOf(await run([quotes, schema("customers"), lines({ parentField: "quoteCode" })]))).toBe('{"collection":"quotes","parentField":"code","childField":"quoteCode"}');
  // only references to existing Schemas count: one quotes id reference plus one to a missing Schema is not ambiguous, standalone included
  const ghost = doc("lines", { title: "Lines", lifecycle: "operational", uiSchema: { nav: { standalone: true } }, schema: { type: "object", required: ["quoteId", "ghostId"], properties: { quoteId: { type: "string", "x-mantle-ref": "quotes" }, ghostId: { type: "string", "x-mantle-ref": "ghosts" } } } });
  expect(parentOf(await run([schema("quotes"), ghost]))).toBe('{"collection":"quotes","parentField":"id","childField":"quoteId"}');
  // folded by the unique-field reference: no standalone hint, since standalone would need an id reference
  const placed = await run([quotes, schema("customers"), lines({ parentField: "quoteCode", order: 1 })]);
  expect(codes(placed)).toEqual(["SCHEMA_UI_INVALID schemas/lines/uiSchema/nav/order"]);
  expect(placed.ok ? "" : placed.diagnostics[0]!.message).not.toContain("nav.standalone: true");
});

test("generate refuses a parentField that is not a required reference, sits on a translation, or closes a parent cycle", async () => {
  for (const parentField of ["label", "missing"]) expect(codes(await run([schema("quotes"), schema("customers"), twoRefs({ parentField }, { label: { type: "string" } })]))).toEqual(["SCHEMA_UI_INVALID /spec/uiSchema/nav/parentField"]);
  expect(codes(await run([posts, locales({ parentField: "slug" })]))).toEqual(["SCHEMA_UI_INVALID /spec/uiSchema/nav/parentField"]);
  const ref = (name: string, to: string) => doc(name, { title: name, lifecycle: "operational", uiSchema: { nav: { parentField: "up" } }, schema: { type: "object", required: ["up"], properties: { up: { type: "string", "x-mantle-ref": to } } } });
  expect(codes(await run([ref("a", "b"), ref("b", "a")]))).toEqual(["SCHEMA_UI_INVALID /spec/uiSchema/nav/parentField", "SCHEMA_UI_INVALID /spec/uiSchema/nav/parentField"]);
  expect(codes(await run([ref("a", "a")]))).toEqual(["SCHEMA_UI_INVALID /spec/uiSchema/nav/parentField"]);
  expect((await run([schema("b"), ref("a", "b")])).ok).toBe(true);
  expect(codes(await run([posts, locales({}), ref("a", "postlocales")]))).toEqual(["SCHEMA_UI_INVALID /spec/uiSchema/nav/parentField"]);
});
