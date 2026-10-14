import { expect, test } from "bun:test";
import { readFile, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeApp, diffApp, targetHash } from "../dist/domain/describe/index.js";
import { compilePlan, sqliteCompiler, type RuntimePlan } from "../src/build/compiler.js";

async function fixture(): Promise<RuntimePlan> {
  const text = await readFile(new URL("apps/user-fields.yaml", import.meta.url), "utf8");
  const result = await compilePlan({ sources: [{ sourceId: "fixture", text }] }, sqliteCompiler, "operational");
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  return result.plan;
}
const target = (report: Awaited<ReturnType<typeof describeApp>>, id: string) => report.targets.find(t => t._meta.id === id)!._meta;
const copy = (plan: RuntimePlan) => JSON.parse(JSON.stringify(plan));

test("describe is deterministic, uses MCP names, reports access without SQL or rows", async () => {
  const plan = await fixture(), a = await describeApp(plan);
  const reversed = { ...plan, schemas: Object.fromEntries(Object.entries(plan.schemas).reverse()), views: Object.fromEntries(Object.entries(plan.views).reverse()), procedures: Object.fromEntries(Object.entries(plan.procedures).reverse()), triggers: Object.fromEntries(Object.entries(plan.triggers).reverse()) };
  expect(await describeApp(reversed)).toEqual(a);
  expect(a.schemaVersion).toBe(1);
  const unguarded = copy(plan); delete unguarded.views["notes-list"].requires;
  expect(target(await describeApp(unguarded), "view:notes-list").requires.all).toContain("ctx.admin");
  expect(a.targets.find(t => t._meta.id === "view:regional-orders")!.name).toBe("regional_orders");
  expect(a.access.region!.restrict).toContain("view:regional-orders");
  expect(a.access.region!.scope).toContain("notes");
  expect(target(a, "view:regional-orders").userFields.region!.allAllowed).toBe(false);
  expect(target(a, "view:notes-list").userFields.region!.allAllowed).toBe(true);
  expect(JSON.stringify(a)).not.toMatch(/SELECT |UPDATE |INSERT |DELETE FROM/);
  expect(a.targets.some(t => t._meta.id === "admin:GET /entries/:id")).toBe(true);
});

test("hash is stable and binds restrictions, scope, input, requirements and SQL behavior", async () => {
  const plan = await fixture(), id = "view:regional-orders", h = await targetHash(plan, id);
  expect(await targetHash(copy(plan), id)).toBe(h);
  expect(target(await describeApp(plan), id).targetHash).toBe(h);
  const mutations = [
    (p: any) => { p.views["regional-orders"].restrict.orders.terms[0].field = "other"; },
    (p: any) => { p.schemas.orders.userScopes = [{ column: "region", field: "region", type: "string" }]; },
    (p: any) => { p.views["regional-orders"].input = { type: "object", properties: { search: { type: "string" } } }; },
    (p: any) => { p.views["regional-orders"].requires = { auth: { all: ["ctx.user"] } }; },
    (p: any) => { p.views["regional-orders"].source += " "; },
  ];
  for (const mutate of mutations) { const p = copy(plan); mutate(p); expect(await targetHash(p, id)).not.toBe(h); }
  await expect(targetHash(plan, "view:missing")).rejects.toThrow("Unknown target");
});

test("readOnly is derived from nested IR and refuses ref-handler claims", async () => {
  const plan = copy(await fixture());
  plan.procedures.preview = { input: { type: "object" }, output: { type: "object" }, inputs: {}, handler: { sql: { grammar: 180004, stmts: [{ SelectStmt: {} }] }, source: "SELECT 1" } };
  plan.procedures.custom = { input: { type: "object" }, output: { type: "object" }, inputs: {}, mcp: { readOnlyHint: true }, handler: { ref: "custom" } };
  const a = await describeApp(plan);
  expect(target(a, "view:notes-list").readOnly).toBe(true);
  expect(target(a, "procedure:rename-order").readOnly).toBe(false);
  expect(target(a, "procedure:preview").readOnly).toBe(true);
  expect(target(a, "procedure:custom").readOnly).toBe(false);
  expect(target(a, "procedure:custom").opaque).toBe(true);
  plan.procedures.preview.handler.sql.stmts[0].SelectStmt.withClause = { ctes: [{ UpdateStmt: {} }] };
  expect(target(await describeApp(plan), "procedure:preview").readOnly).toBe(false);
});

test("diff classifies conjunctive removals as widened, additions as narrowed", async () => {
  const plan = await fixture(), a = await describeApp(plan), p = copy(plan);
  delete p.views["regional-orders"].restrict;
  const b = await describeApp(p);
  expect(diffApp(a, b)).toContainEqual(expect.objectContaining({ id: "view:regional-orders", field: "restrict", direction: "widened" }));
  expect(diffApp(a, b)).toContainEqual(expect.objectContaining({ id: "view:regional-orders", field: "allAllowed", direction: "widened" }));
  expect(diffApp(b, a)).toContainEqual(expect.objectContaining({ id: "view:regional-orders", field: "restrict", direction: "narrowed" }));
  delete p.views["regional-orders"];
  expect(diffApp(a, await describeApp(p))).toContainEqual({ id: "view:regional-orders", field: "target", direction: "narrowed" });
});

test("CLI --json equals describeApp and --diff writes nothing into the project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mantle-describe-"));
  try {
    const cli = new URL("../dist/infrastructure/cli.js", import.meta.url).pathname;
    const manifest = new URL("apps/user-fields.yaml", import.meta.url).pathname;
    const sources = { sources: [{ sourceId: manifest, text: await readFile(manifest, "utf8") }] };
    const compiled = await compilePlan(sources, sqliteCompiler, "operational");
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    const report = await describeApp(compiled.plan);
    const json = execFileSync("node", [cli, "describe", "--json", manifest], { cwd: dir, encoding: "utf8" });
    expect(JSON.parse(json)).toEqual(report);
    expect(await readdir(dir)).toEqual([]);
    await writeFile(join(dir, "old.json"), json);
    expect(execFileSync("node", [cli, "describe", manifest, "--diff", "old.json"], { cwd: dir, encoding: "utf8" }).trim()).toBe("No changes.");
    expect(await readdir(dir)).toEqual(["old.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("read flags distinguish insert targets, owner reads and translation parents", async () => {
  const plan = copy(await fixture());
  plan.schemas.orders.scope = "author_id";
  plan.schemas.notes.translates = { parent: "orders", on: "id" };
  plan.procedures.insertOnly = { input: { type: "object" }, output: { type: "object" }, inputs: {}, handler: { sql: { grammar: 180004, stmts: [{ InsertStmt: { relation: { relname: "orders" } } }] }, source: "INSERT INTO orders DEFAULT VALUES" } };
  const a = await describeApp(plan);
  expect(target(a, "procedure:insertOnly").readOnly).toBe(false);
  expect(target(a, "procedure:insertOnly").ownerScoped).toBe(false);
  expect(target(a, "procedure:insertOnly").unscopedReads).toBe(false);
  expect(target(a, "view:notes-list").ownerScoped).toBe(true);
  expect(a.access).not.toHaveProperty("id");
  expect(target(a, "view:notes-list").userFields).not.toHaveProperty("id");
  const h = await targetHash(plan, "view:notes-list");
  delete plan.schemas.orders.scope;
  expect(await targetHash(plan, "view:notes-list")).not.toBe(h);
});

test("Admin catalogue includes every literal built-in server route", async () => {
  const report = await describeApp(await fixture());
  for (const file of ["index", "entries", "site", "webmcp"]) {
    const source = await readFile(new URL(`../../mantle-admin/src/server/${file}.ts`, import.meta.url), "utf8");
    for (const [, method, path] of source.matchAll(/method: "([A-Z]+)"(?: as const)?, path: "([^"]+)"/g)) {
      const id = `admin:${method} ${path!.replace(/\{([^}]+)\}/g, ":$1")}`;
      expect(report.targets.some(t => t._meta.id === id)).toBe(true);
    }
  }
});

const H = "apiVersion: cms.mantle.aotter.net/v2\n";
async function compile(text: string): Promise<RuntimePlan> {
  const result = await compilePlan({ sources: [{ sourceId: "regression", text }] }, sqliteCompiler, "operational");
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  return result.plan;
}
const fixtureText = () => readFile(new URL("apps/user-fields.yaml", import.meta.url), "utf8");
const posts = `${H}kind: Schema
metadata: {name: posts}
spec:
  title: Posts
  lifecycle: publishing
  schema: {type: object, required: [title], properties: {title: {type: string}}}
---
${H}kind: View
metadata: {name: posts-admin}
spec:
  surface: admin
  requires: {auth: {all: [ctx.admin]}}
  sql: SELECT id, title FROM posts ORDER BY id
`;
const dual = `${H}kind: Schema
metadata: {name: things}
spec:
  title: Things
  lifecycle: operational
  schema: {type: object, required: [title], properties: {title: {type: string}}}
---
${H}kind: Procedure
metadata: {name: add-thing}
spec:
  input: {type: object, required: [title], properties: {title: {type: string}}}
  output: {type: object}
  handler: {sql: "INSERT INTO things (title) VALUES (input.title) RETURNING id"}
---
${H}kind: Trigger
metadata: {name: add-admin}
spec: {source: {kind: mcp, surface: admin}, target: {procedure: add-thing}}
`;
const auditHook = `---\n${H}kind: Procedure
metadata: {name: audit}
spec:
  input: {type: object}
  output: {type: object}
  handler: {ref: audit}
---
${H}kind: Trigger
metadata: {name: audit-hook}
spec: {source: {kind: lifecycle, schema: orders, on: [after_update]}, target: {procedure: audit}}
`;

test("WebMCP dispatch includes publishing and media tools and cannot claim readOnly", async () => {
  const report = await describeApp(await compile(posts));
  const dispatcher = target(report, "admin:POST /webmcp/:tool");
  expect(dispatcher.readOnly).toBe(false);
  for (const verb of ["publish", "unpublish", "archive"]) {
    const id = `procedure:posts.${verb}`;
    expect(dispatcher.variants.some(v => v.id === id)).toBe(true);
    expect(target(report, id).readOnly).toBe(false);
    expect(report.targets.find(t => t._meta.id === id)!.name).toBe(`${verb}_posts`);
  }
  for (const name of ["get_media_upload_policy", "create_media_upload", "commit_media_upload", "list_media_assets", "get_media_asset", "update_media_asset", "delete_media_asset"])
    expect(dispatcher.variants.some(v => v.id === `admin:tool:${name}`)).toBe(true);
  const empty = await describeApp(await compile(dual.split("---").slice(0, 2).join("---")));
  expect(target(empty, "admin:POST /operations/:name").readOnly).toBe(false);
  expect(target(empty, "admin:GET /views/:name").readOnly).toBe(false);
});

test("public MCP and REST exposure survives an admin MCP binding with independent gates", async () => {
  const plan = await compile(dual + `---\n${H}kind: Trigger\nmetadata: {name: add-public}\nspec: {source: {kind: mcp, surface: public}, target: {procedure: add-thing}}\n---\n${H}kind: Trigger\nmetadata: {name: add-http}\nspec: {source: {kind: http, method: POST, path: /api/things}, target: {procedure: add-thing}}\n`);
  const m = target(await describeApp(plan), "procedure:add-thing");
  expect(m.surface).toBe("public");
  expect(m.surfaces).toEqual(["admin", "public", "rest"]);
  expect(m.requires.all).toEqual([]);
  expect(m.requiresBySurface).toEqual({ admin: { all: ["ctx.admin"] }, public: { all: [] }, rest: { all: [] } });
  expect(m.triggers.map(t => t.id)).toEqual(["add-admin", "add-http", "add-public"]);
});

test("internal to public, new triggers and removing trustedOnly widen and change hashes", async () => {
  const internal = await compile(dual.split("---").slice(0, 2).join("---"));
  const pub = await compile(dual.replace("surface: admin", "surface: public"));
  const id = "procedure:add-thing";
  expect(await targetHash(internal, id)).not.toBe(await targetHash(pub, id));
  expect(diffApp(await describeApp(internal), await describeApp(pub))).toContainEqual(expect.objectContaining({ id, field: "surfaces", direction: "widened" }));
  const trusted = copy(internal); trusted.procedures["add-thing"].trustedOnly = true;
  const changes = diffApp(await describeApp(trusted), await describeApp(internal));
  expect(changes).toContainEqual(expect.objectContaining({ id, field: "trustedOnly", direction: "widened" }));
  expect(changes).toContainEqual(expect.objectContaining({ id, field: "hostCallable", direction: "widened" }));
  const second = copy(pub); second.triggers.second = { source: { kind: "mcp", surface: "public" }, procedure: "add-thing" };
  expect(await targetHash(pub, id)).not.toBe(await targetHash(second, id));
  expect(diffApp(await describeApp(pub), await describeApp(second))).toContainEqual(expect.objectContaining({ id, field: "triggers", direction: "widened" }));
});

test("adding a public trigger to an admin procedure changes its hash and widens exposure", async () => {
  const a = await fixture();
  const b = await compile(await fixtureText() + `---\n${H}kind: Trigger\nmetadata: {name: rename-public}\nspec: {source: {kind: mcp, surface: public}, target: {procedure: rename-order}}\n`);
  const id = "procedure:rename-order";
  expect(await targetHash(a, id)).not.toBe(await targetHash(b, id));
  const rb = await describeApp(b);
  expect(diffApp(await describeApp(a), rb)).toContainEqual(expect.objectContaining({ id, field: "surfaces", direction: "widened" }));
  // This predicate is authored on the Procedure and therefore remains on its public path.
  expect(target(rb, id).requiresBySurface.public!.all).toEqual(["ctx.admin"]);
});

test("removing ref or SQL guards and loosening auth requirements widen", async () => {
  for (const sqlGuard of [false, true]) {
    const guard = `---\n${H}kind: Procedure\nmetadata: {name: gate}\nspec:\n  input: {type: object}\n  output: {type: object}\n  handler: {ref: gate}\n`;
    const text = await fixtureText();
    const a = await compile(text.replace("requires: {auth: {all: [ctx.admin]}}\n  restrict: {orders:", "requires: {auth: {all: [ctx.admin]}, guard: {procedure: gate}}\n  restrict: {orders:") + guard);
    const b = await compile(text + guard);
    if (sqlGuard) {
      (a.procedures.gate as any).handler = { sql: { grammar: 180004, stmts: [{ SelectStmt: {} }] }, source: "SELECT 1" };
      (b.procedures.gate as any).handler = (a.procedures.gate as any).handler;
    }
    expect(target(await describeApp(a), "view:regional-orders").requires.guard).toBe("gate");
    expect(diffApp(await describeApp(a), await describeApp(b))).toContainEqual(expect.objectContaining({ id: "view:regional-orders", field: "requires", direction: "widened" }));
  }
  const a = copy(await fixture()), b = copy(a);
  a.procedures["rename-order"].requires.auth.all.push("ctx.user");
  expect(diffApp(await describeApp(a), await describeApp(b))).toContainEqual(expect.objectContaining({ id: "procedure:rename-order", field: "requires", direction: "widened" }));
});

test("reading another Schema widens, while adding terms to a read Schema narrows", async () => {
  const a = await describeApp(await fixture()), b = structuredClone(a), id = "view:all-orders";
  target(b, id).scope = { ...target(b, id).scope, notes: { terms: [{ column: "area", field: "region", type: "string" }] } };
  expect(diffApp(a, b)).toContainEqual(expect.objectContaining({ id, field: "scope", direction: "widened" }));
  const c = structuredClone(a);
  target(c, id).scope = { ...target(c, id).scope, orders: { terms: [{ column: "region", field: "region", type: "string" }] } };
  expect(diffApp(a, c)).toContainEqual(expect.objectContaining({ id, field: "scope", direction: "narrowed" }));
  const text = (await fixtureText()).replace("sql: SELECT id, title, region FROM orders ORDER BY title, id", "sql: SELECT o.id, o.title, n.title AS note FROM orders o LEFT JOIN notes n ON n.id = o.id ORDER BY o.title, o.id");
  expect(diffApp(a, await describeApp(await compile(text)))).toContainEqual(expect.objectContaining({ id, field: "scope", direction: "widened" }));
});

test("lifecycle hooks pin writers, REST and generic entries routes and expose ref opacity", async () => {
  const a = await fixture(), b = await compile(await fixtureText() + auditHook);
  for (const id of ["procedure:rename-order", "rest:POST /api/orders/rename", "admin:PATCH /entries/:id"]) {
    expect(await targetHash(b, id)).not.toBe(await targetHash(a, id));
    expect(target(await describeApp(b), id).opaque).toBe(true);
    expect(diffApp(await describeApp(a), await describeApp(b))).toContainEqual(expect.objectContaining({ id, field: "opaque", direction: "widened" }));
  }
  const changed = copy(b); changed.procedures.audit.handler.ref = "different";
  expect(await targetHash(changed, "procedure:rename-order")).not.toBe(await targetHash(b, "procedure:rename-order"));
  const unrelated = copy(b); unrelated.triggers["audit-hook"].source.on = ["after_delete"];
  expect(await targetHash(unrelated, "procedure:rename-order")).toBe(await targetHash(a, "procedure:rename-order"));
  expect(await targetHash(a, "view:regional-orders")).toBe(await targetHash(b, "view:regional-orders"));
});

test("publishing hooks pin publishing tools and their dispatchers", async () => {
  const a = await compile(posts), b = copy(a);
  b.procedures.hook = { input: { type: "object" }, output: { type: "object" }, inputs: {}, handler: { ref: "publish-hook" } };
  b.triggers.hook = { source: { kind: "lifecycle", schema: "posts", on: ["before_publish", "after_publish"] }, procedure: "hook" };
  for (const id of ["procedure:posts.publish", "admin:POST /webmcp/:tool", "admin:POST /entries/:id/publish"]) {
    expect(await targetHash(a, id)).not.toBe(await targetHash(b, id));
    expect(target(await describeApp(b), id).opaque).toBe(true);
  }
});

test("ref handlers conservatively report all possible read scopes", async () => {
  const plan = copy(await fixture());
  plan.schemas.notes.scope = "author_id";
  plan.procedures.custom = { input: { type: "object" }, output: { type: "object" }, inputs: {}, handler: { ref: "custom" } };
  const m = target(await describeApp(plan), "procedure:custom");
  expect([m.opaque, m.unscopedReads, m.ownerScoped]).toEqual([true, true, true]);
});

test("guard restrict terms appear in guarded fields and cannot be dropped with allAllowed", async () => {
  const plan = copy(await fixture());
  plan.procedures.g = { ...copy(plan).procedures["rename-order"], restrict: { orders: { terms: [{ column: "tier", field: "tier", type: "string" }] } } };
  plan.views["notes-list"].requires = { auth: { all: ["ctx.admin"] }, guard: { procedure: "g" } };
  const report = await describeApp(plan), m = target(report, "view:notes-list");
  expect(m.restrict.orders!.terms).toEqual([{ column: "tier", field: "tier", type: "string" }]);
  expect(m.userFields.tier!.allAllowed).toBe(false);
  expect(report.access.tier!.restrict).toContain("view:notes-list");
  expect(m.readOnly).toBe(false);
});

test("dispatcher restrictions stay per variant and any variant loosening widens", async () => {
  const a = copy(await fixture());
  a.views["tier-orders"].surface = "admin";
  a.views["tier-orders"].restrict = copy(a).views["regional-orders"].restrict;
  const before = await describeApp(a), b = copy(a);
  delete b.views["regional-orders"].restrict;
  const after = await describeApp(b);
  for (const id of ["admin:GET /views/:name", "admin:GET /developer/views/:name"]) {
    expect(target(before, id).restrict.orders!.terms).toEqual([]);
    expect(target(before, id).variants.find(v => v.id === "view:regional-orders")!.restrict.orders!.terms).toHaveLength(1);
    expect(diffApp(before, after)).toContainEqual(expect.objectContaining({ id, field: "variants", direction: "widened" }));
  }
});

test("expanded View SQL pins outer behavior; inner target restrictions stay on the inner target", async () => {
  const base = await fixtureText();
  const mk = (sql: string, restrict = "") => base + `---\n${H}kind: View\nmetadata: {name: inner_v}\nspec:\n  title: inner\n  surface: internal\n${restrict}  sql: ${sql}\n---\n${H}kind: View\nmetadata: {name: outer-v}\nspec:\n  title: outer\n  surface: public\n  sql: SELECT id, title FROM inner_v ORDER BY id\n`;
  const a = await compile(mk("SELECT id, title FROM orders ORDER BY id"));
  const b = await compile(mk("SELECT id, title FROM orders WHERE tier = 'x' ORDER BY id"));
  const c = await compile(mk("SELECT id, title FROM orders ORDER BY id", "  restrict: {orders: \"region IN auth.user('region')\"}\n"));
  expect(await targetHash(a, "view:outer-v")).not.toBe(await targetHash(b, "view:outer-v"));
  expect(await targetHash(a, "view:outer-v")).toBe(await targetHash(c, "view:outer-v"));
  expect(target(await describeApp(c), "view:outer-v").restrict).toEqual({});
  expect(diffApp(await describeApp(c), await describeApp(a))).toContainEqual(expect.objectContaining({ id: "view:inner_v", field: "restrict", direction: "widened" }));
});

test("standalone route hashes retain the global user-field vocabulary", async () => {
  const a = await fixture(), b = await compile(`${H}kind: Schema\nmetadata: {name: zz}\nspec:\n  title: Z\n  lifecycle: operational\n  schema: {type: object, properties: {a: {type: string}}}\n`);
  const sameFields = { ...b, access: a.access };
  for (const id of ["admin:PATCH /admin/:id/role", "admin:POST /admin/invitations", "admin:PATCH /site-settings", "admin:POST /media/uploads"]) {
    expect(await targetHash(a, id)).not.toBe(await targetHash(b, id));
    expect(await targetHash(a, id)).toBe(await targetHash(sameFields, id));
  }
});

test("starting to read an unscoped Schema is widened", async () => {
  const base = await fixtureText(), extra = `---\n${H}kind: Schema\nmetadata: {name: secrets}\nspec:\n  title: S\n  lifecycle: operational\n  schema: {type: object, properties: {v: {type: string}}}\n`;
  const a = await compile(base + extra), b = await compile(base.replace("sql: SELECT id, title FROM notes ORDER BY id", "sql: SELECT n.id, n.title, s.v FROM notes n LEFT JOIN secrets s ON s.id = n.id ORDER BY n.id") + extra);
  const before = await describeApp(a), after = await describeApp(b), id = "view:notes-list";
  expect(target(before, id).unscopedReads).toBe(false);
  expect(target(after, id).unscopedReads).toBe(true);
  expect(diffApp(before, after)).toContainEqual(expect.objectContaining({ id, field: "unscopedReads", direction: "widened" }));
});

test("input loosening is widened and uncertain input changes are changed", async () => {
  const a = await fixture(), before = await describeApp(a), id = "procedure:rename-order";
  for (const mutate of [
    (p: any) => { p.procedures["rename-order"].input.required = ["id"]; },
    (p: any) => { delete p.procedures["rename-order"].input.properties.title.minLength; },
    (p: any) => { p.procedures["rename-order"].input.additionalProperties = true; },
  ]) {
    const b = copy(a); mutate(b);
    expect(diffApp(before, await describeApp(b))).toContainEqual(expect.objectContaining({ id, field: "inputSchema", direction: "widened" }));
  }
  const b = copy(a); b.procedures["rename-order"].input.anyOf = [{ required: ["title"] }];
  expect(diffApp(before, await describeApp(b))).toContainEqual(expect.objectContaining({ id, field: "inputSchema", direction: "changed" }));
});

test("target hashes normalize optional lowering away for all targets", async () => {
  const a = await fixture(), b = copy(a);
  b.lowered = { mantle: "cache", dialect: { ...a.dialect, key: "cache" }, views: { "regional-orders": { caller: { sql: "cached", binds: [] } } }, procedures: { "rename-order": { caller: [{ sql: "cached", binds: [] }] } } };
  const report = await describeApp(a);
  for (const t of report.targets) expect(await targetHash(a, t._meta.id)).toBe(await targetHash(b, t._meta.id));
  expect(diffApp(report, await describeApp(b))).toEqual([]);
});

test("a dispatcher reports widening in one variant even when aggregate flags stay unchanged", async () => {
  const a = copy(await fixture());
  a.procedures["rename-order"].trustedOnly = true;
  a.procedures.second = { ...a.procedures["rename-order"] };
  a.triggers.second = { source: { kind: "mcp", surface: "admin" }, procedure: "second" };
  const b = copy(a); delete b.procedures["rename-order"].trustedOnly;
  const before = await describeApp(a), after = await describeApp(b);
  for (const id of ["admin:POST /operations/:name", "admin:POST /webmcp/:tool"]) {
    expect(target(before, id).hostCallable).toBe(false);
    expect(target(after, id).hostCallable).toBe(false);
    expect(diffApp(before, after)).toContainEqual(expect.objectContaining({ id, field: "variants", direction: "widened" }));
  }
});

test("a Procedure Trigger does not expose a View with the same name", async () => {
  const plan = copy(await fixture());
  plan.views["rename-order"] = plan.views["all-orders"];
  plan.triggers.public = { source: { kind: "mcp", surface: "public" }, procedure: "rename-order" };
  const report = await describeApp(plan), m = target(report, "view:rename-order");
  expect(m.surface).toBe("internal");
  expect(m.surfaces).toEqual(["admin", "internal"]);
  expect(m.triggers).toEqual([]);
  expect(report.targets.some(t => t._meta.id === "rest:GET /api/views/rename-order")).toBe(false);
});
