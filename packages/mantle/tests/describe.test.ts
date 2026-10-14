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
