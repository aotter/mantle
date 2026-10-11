import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { auth } from "./apps/auth/auth.js";

test("the entry module never contains Better Auth: it is split out behind import()", async () => {
  const build = await Bun.build({ entrypoints: [new URL("apps/auth/worker.ts", import.meta.url).pathname], target: "browser", format: "esm", splitting: true, minify: true });
  expect(build.success).toBe(true);
  // What a cold isolate evaluates: the entry and every chunk it imports statically (not through import()).
  const byName = new Map(await Promise.all(build.outputs.map(async o => [o.path.split("/").pop()!, await o.text()] as const)));
  const startup = new Set<string>();
  const visit = (name: string) => {
    if (startup.has(name)) return;
    startup.add(name);
    for (const m of byName.get(name)!.matchAll(/(?:^|;)import(?:[^"(]*from)?"\.\/([^"]+)"/g)) visit(m[1]!);
  };
  visit(build.outputs.find(o => o.kind === "entry-point")!.path.split("/").pop()!);
  const bytes = [...startup].reduce((n, name) => n + byName.get(name)!.length, 0);
  // Better Auth, its cookie helper and the OAuth resource client are hundreds of KB, all behind import().
  expect(bytes).toBeLessThan(4096);
  expect(build.outputs.filter(o => o.kind === "chunk").length).toBeGreaterThan(0);
});

test("--auth adds the application's Better Auth tables to schema.sql, applicable twice", async () => {
  const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: notes}
spec:
  title: Notes
  lifecycle: operational
  indexes: [[title]]
  schema: {type: object, required: [title], properties: {title: {type: string}}}
`;
  const generated = await generateFromSources({ target: "cloudflare-d1", sources: { sources: [{ sourceId: "n.yaml", text: source }] }, auth: auth.options });
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const sql = generated.files["schema.sql"]!;
  for (const table of ["user", "session", "verification", "jwks", "oauthClient"]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
  const db = new Database(":memory:");
  db.exec(sql); db.exec(sql);
  expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'user'`).all()).toHaveLength(1);
});

test("field index names match Better Auth's own rule, including the hashed long form", async () => {
  // Test-only use of Better Auth's internal helper: production code reproduces it from public data.
  const { getDatabaseFieldIndexName } = await import("@better-auth/core/db/internal");
  const { fieldIndexName } = await import("../src/auth/schema.js");
  for (const [table, column] of [["session", "userId"], ["oauthAccessToken", "a".repeat(80)], ["t".repeat(70), "c"]] as const)
    expect(fieldIndexName(table, column)).toBe(getDatabaseFieldIndexName(table, column, false));
});
