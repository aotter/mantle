/** Diff directions and hash stability found by review. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
const { describeApp, diffApp, targetHash } = await import("../src/domain/describe/index.js");
const { compilePlan, sqliteCompiler } = await import("../src/build/compiler.js");
const H = "apiVersion: cms.mantle.aotter.net/v2\n";
async function compile(text: string) {
  const r = await compilePlan({ sources: [{ sourceId: "x", text }] }, sqliteCompiler, "operational");
  if (!r.ok) throw Error(JSON.stringify(r.diagnostics.filter((d: any) => d.severity === "error")));
  return r.plan;
}
const base = await readFile(new URL("apps/user-fields.yaml", import.meta.url), "utf8");
const meta = (r: any, id: string) => r.targets.find((t: any) => t._meta.id === id)?._meta;
const copy = (p: any) => JSON.parse(JSON.stringify(p));
const dirs = (c: any[], id: string) => c.filter(x => x.id === id).map(x => [x.field, x.direction]);

test("diff: swapping a restrict term (region for tier) is widened", async () => {
  const a = await compile(base);
  const b = await compile(base.replace(`restrict: {orders: "region IN auth.user('region')"}\n  sql: SELECT id, title, region`, `restrict: {orders: "tier IN auth.user('tier')"}\n  sql: SELECT id, title, region`));
  const c = diffApp(await describeApp(a), await describeApp(b));
  expect(dirs(c, "view:regional-orders").some(([, d]: any) => d === "widened")).toBe(true);
});

test("targetHash does not depend on the process locale", async () => {
  const p = await compile(base + `---\n${H}kind: Trigger\nmetadata: {name: rename-y}\nspec: {source: {kind: http, method: POST, path: /api/y}, target: {procedure: rename-order}}\n---\n${H}kind: Trigger\nmetadata: {name: rename-j}\nspec: {source: {kind: http, method: POST, path: /api/j}, target: {procedure: rename-order}}\n`);
  const en = await targetHash(p, "procedure:rename-order");
  const orig = String.prototype.localeCompare;
  String.prototype.localeCompare = function (this: string, that: string) { return orig.call(this, that, "lt"); } as any;
  try { const lt = await targetHash(p, "procedure:rename-order"); expect(lt).toBe(en); }
  finally { String.prototype.localeCompare = orig; }
});
