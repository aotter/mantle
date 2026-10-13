/** ADR-0046 spike: generation refuses undeclared roles and attributes; `catalog.json` lists the exposed targets and hashes their input schemas. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateFromSources } from "../src/infrastructure/generate.js";
import type { Target } from "../src/domain/model.js";

const base = readFileSync(resolve(import.meta.dir, "apps/attrs.yaml"), "utf8");
const run = (text: string, target: Target = "bun-sqlite") => generateFromSources({ target, sources: { sources: [{ sourceId: "attrs.yaml", text }] } });
const refused = async (text: string) => { const r = await run(text); expect(r.ok).toBe(false); return r.ok ? "" : r.diagnostics.map(d => d.message).join("\n"); };
const catalogOf = async (text: string, target: Target = "bun-sqlite") => { const r = await run(text, target); if (!r.ok) throw Error(JSON.stringify(r.diagnostics)); return JSON.parse(r.files["catalog.json"]!) as { auth: any; targets: any[] }; };
const without = (text: string) => text.slice(text.indexOf("---\napiVersion") + 4);

describe("declared roles and attributes", () => {
  test("the fixture generates on every target", async () => {
    for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const) expect((await run(base, target)).ok).toBe(true);
  });
  test("an undeclared role in ctx.staff is refused, with or without an auth block", async () => {
    expect(await refused(base.replace("{ctx.staff: [sales]}", "{ctx.staff: [finance]}"))).toContain("'finance'");
    expect(await refused(without(base).replaceAll("auth.attr('tier')", "x"))).toContain("role 'sales'");
  });
  test("a declared role may not be 'staff' (built in) and the block is closed", async () => {
    expect(await refused(base.replace("roles: [sales]", "roles: [staff]"))).toContain("built in");
    expect(await refused(base.replace("roles: [sales]", "roles: [sales]\n  extra: 1"))).toContain("auth");
    expect(await refused(base.replace("type: string, multiple: true", "type: boolean"))).toContain("'string' or 'number'");
  });
  test("an undeclared attribute is refused in SQL, in a scope, and when no auth block exists", async () => {
    expect(await refused(base.replace("auth.attr('tier')", "auth.attr('dept')"))).toContain("does not declare attribute 'dept' (declared: region, tier)");
    expect(await refused(base.replace(`area: "auth.attr('region')"`, `area: "auth.attr('dept')"`))).toContain("does not declare");
    expect(await refused(without(base).replace("{ctx.staff: [sales]}", "ctx.user").replace("{ctx.staff: [sales]}", "ctx.user").replace("{ctx.staff: [sales]}", "ctx.user").replace(`area: "auth.attr('region')"`, `area: "auth.uid()"`))).toContain("auth.attr");
  });
  test("an attribute reference has one literal name and a multi-valued attribute stands alone in IN", async () => {
    expect(await refused(base.replace("tier = auth.attr('tier')", "tier = auth.attr(title)"))).toContain("one literal attribute name");
    expect(await refused(base.replace("tier = auth.attr('tier')", "tier = auth.attr('tier', 'x')"))).toContain("one literal attribute name");
    expect(await refused(base.replace("region IN (auth.attr('region')) ORDER BY id", "region = auth.attr('region') ORDER BY id"))).toContain("multi-valued");
    expect(await refused(base.replace("region IN (auth.attr('region')) ORDER BY id", "region NOT IN (auth.attr('region')) ORDER BY id"))).toContain("not negated");
  });
  test("an attribute-scoped Schema is operational, and only the Store writes it", async () => {
    expect(await refused(base.replace("lifecycle: operational\n  scope:", "lifecycle: publishing\n  scope:"))).toContain("attribute-scoped");
    const insert = `---\napiVersion: cms.mantle.aotter.net/v2\nkind: Procedure\nmetadata: {name: add-note}\nspec:\n  input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}\n  output: {type: object}\n  handler: {sql: "INSERT INTO notes (title) VALUES (input.title) RETURNING id"}\n`;
    expect(await refused(base + insert)).toContain("write it through the Store");
  });
  test("an app without an auth block is unchanged: the legacy refusal of unknown roles stays", async () => {
    const plain = `apiVersion: cms.mantle.aotter.net/v2\nkind: Schema\nmetadata: {name: items}\nspec: {title: Items, lifecycle: operational, schema: {type: object, properties: {title: {type: string}}, required: [title]}}\n---\napiVersion: cms.mantle.aotter.net/v2\nkind: View\nmetadata: {name: v}\nspec: {surface: staff, requires: {auth: {all: [{ctx.staff: [owner]}]}}, sql: "SELECT id, title FROM items ORDER BY id"}\n`;
    expect(await refused(plain)).toContain("outside the generated vocabulary (staff)");
  });
});

describe("catalog.json", () => {
  test("lists each exposed target with tool, surface, schema, annotations, roles and attributes read", async () => {
    const { auth, targets } = await catalogOf(base);
    expect(auth).toEqual({ roles: ["staff", "sales"], attributes: { region: { type: "string", multiple: true }, tier: { type: "string", multiple: false } } });
    expect(targets.map(t => `${t.target} ${t.surface} ${t.tool}`)).toEqual([
      "procedure:rename-order mcp:staff rename_order",
      "procedure:rename-order rest POST /api/orders/rename",
      "view:notes-list mcp:staff notes_list",
      "view:regional-orders mcp:staff regional_orders",
    ]);
    const by = (target: string, surface: string) => targets.find(t => t.target === target && t.surface === surface);
    expect(by("view:regional-orders", "mcp:staff")).toMatchObject({ roles: ["sales"], attributes: ["region"], annotations: { readOnlyHint: true }, authenticated: true });
    expect(by("view:regional-orders", "mcp:staff").inputSchema.properties).toHaveProperty("limit");
    // the scope of a Schema counts: notes-list names no attribute in its SQL
    expect(by("view:notes-list", "mcp:staff").attributes).toEqual(["region"]);
    expect(by("procedure:rename-order", "rest")).toMatchObject({ roles: ["sales"], attributes: ["region"] });
    // internal Views are not exposed at all
    expect(targets.some(t => /tier-orders|all-orders|negated/.test(t.target))).toBe(false);
    // no SQL and no data
    expect(JSON.stringify(targets)).not.toMatch(/SELECT|UPDATE|json_each|FROM /);
  });
  test("an app without attributes lists none and still has a catalog", async () => {
    const purchase = readFileSync(resolve(import.meta.dir, "apps/surfaces.yaml"), "utf8");
    const { auth, targets } = await catalogOf(purchase);
    expect(auth).toEqual({ roles: ["staff"], attributes: {} });
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every(t => t.attributes.length === 0)).toBe(true);
  });
  test("the same schema hashes the same: across runs, targets, surfaces and key order", async () => {
    const a = await catalogOf(base), b = await catalogOf(base), pg = await catalogOf(base, "bun-postgres");
    expect(b).toEqual(a);
    expect(pg.targets.map(t => t.inputHash)).toEqual(a.targets.map(t => t.inputHash));
    const rename = a.targets.filter(t => t.target === "procedure:rename-order");
    expect(new Set(rename.map(t => t.inputHash)).size).toBe(1);
    const reordered = base.replace("input: {type: object, required: [id, title], properties: {id: {type: string}, title: {type: string, minLength: 1}}, additionalProperties: false}", "input: {additionalProperties: false, properties: {title: {minLength: 1, type: string}, id: {type: string}}, required: [id, title], type: object}");
    expect(reordered).not.toBe(base);
    expect((await catalogOf(reordered)).targets.map(t => t.inputHash)).toEqual(a.targets.map(t => t.inputHash));
  });
  test("a changed input changes only that target's hash; text-only edits change none", async () => {
    const a = await catalogOf(base);
    const changed = await catalogOf(base.replace("title: {type: string, minLength: 1}}, additionalProperties: false}", "title: {type: string, minLength: 2}}, additionalProperties: false}"));
    const diff = a.targets.filter((t, i) => t.inputHash !== changed.targets[i].inputHash).map(t => t.target);
    expect(new Set(diff)).toEqual(new Set(["procedure:rename-order"]));
    expect(diff.length).toBe(2); // its mcp and rest entries
    for (const [i, t] of a.targets.entries()) if (t.target !== "procedure:rename-order") expect(changed.targets[i]).toEqual(t);
    const retitled = await catalogOf(base.replace("title: Rename an order", "title: Rename an order please"));
    expect(retitled.targets.map(t => t.inputHash)).toEqual(a.targets.map(t => t.inputHash));
    expect(retitled.targets.find(t => t.target === "procedure:rename-order")!.title).toBe("Rename an order please");
  });
});
