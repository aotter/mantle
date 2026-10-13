import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateFromSources } from "../src/infrastructure/generateAuth.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { bundle, guardStartup } from "../src/infrastructure/bundle.js";
import { authOptions } from "./apps/auth/auth.js";

test("bundle splits Better Auth behind import() and refuses a static auth import", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-auth-bundle-"));
  const entry = new URL("apps/auth/worker.ts", import.meta.url).pathname;
  const cli = new URL("../dist/infrastructure/cli.js", import.meta.url).pathname;
  try {
    const metafile = await bundle(entry, join(dir, "dist"));
    expect(Object.keys(metafile.outputs).some(name => name.endsWith("/worker.js"))).toBe(true);
    expect(Object.keys(metafile.outputs).filter(name => name.includes("/chunks/")).length).toBeGreaterThan(0);
    expect(Object.keys(metafile.inputs).some(name => name.includes("better-auth"))).toBe(true);
    const routes = join(dir, "routes.ts");
    await writeFile(routes, `import {authRoutes} from ${JSON.stringify(new URL("../dist/auth/routes.js", import.meta.url).pathname)}; export default {fetch:authRoutes({get:async()=>{throw Error("unselected Auth fixture");}},{methods:[{kind:"email-otp"}]})};`);
    await bundle(routes, join(dir, "routes-dist"));
    await writeFile(join(dir, "dist/stale.js"), "stale");
    execFileSync("node", [cli, "bundle", entry, join(dir, "dist")], { stdio: "pipe" });
    expect(existsSync(join(dir, "dist/stale.js"))).toBe(false);
    await expect(bundle(entry, ".")).rejects.toThrow("working directory");
    await expect(bundle(entry, new URL("apps/", import.meta.url).pathname)).rejects.toThrow("contain the source entry");
    expect(existsSync(entry)).toBe(true);
    const eager = join(dir, "eager.ts");
    await writeFile(eager, `export { default } from ${JSON.stringify(entry)}; export { createAuth } from ${JSON.stringify(new URL("apps/auth/auth.ts", import.meta.url).pathname)};`);
    const failed = spawnSync("node", [cli, "bundle", eager, join(dir, "eager-dist")], { encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/Startup module .*chunks\/.* contains .*better-auth/);
    expect(failed.stderr).toContain("authLoader(() => import(...))");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("bundle refuses the generator on the startup graph, built or from source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-compiler-bundle-"));
  try {
    for (const target of ["../dist/infrastructure/generate.js", "../src/infrastructure/generate.ts"]) {
      const entry = join(dir, "worker.ts");
      await writeFile(entry, `export * from ${JSON.stringify(new URL(target, import.meta.url).pathname)};`);
      await expect(bundle(entry, join(dir, "dist"))).rejects.toThrow(/Startup module .* contains .*Generator code must not run in a Worker; import runtime entry points such as @aotter\/mantle\/rest/);
    }
    for (const input of ["node_modules/.pnpm/@aotter+mantle@1/node_modules/@aotter/mantle/dist/build/x.js", "../../packages/mantle/dist/infrastructure/x.js", "../../packages/mantle/src/build/x.ts", ...["yaml", "pgsql-deparser", "libpg-query"].map(name => `../../node_modules/.pnpm/${name}@1/node_modules/${name}/index.js`)]) {
      const metafile = { inputs: {}, outputs: { "out/w.js": { bytes: 1, inputs: { [input]: { bytesInOutput: 1 } }, imports: [], exports: [], entryPoint: "w.ts" } } };
      expect(() => guardStartup(metafile, "w.ts")).toThrow("Generator code must not run in a Worker");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);

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
  const generated = await generateFromSources({ target: "cloudflare-d1", sources: { sources: [{ sourceId: "n.yaml", text: source }] }, auth: authOptions({ DB: undefined as never, ORIGIN: "https://app.example" }) });
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const sql = generated.files["schema.sql"]!;
  const noEnv = await generateFromSources({ target: "cloudflare-d1", sources: { sources: [{ sourceId: "n.yaml", text: source }] }, auth: authOptions(new Proxy({} as never, { get: () => undefined })) });
  if (!noEnv.ok) throw Error(JSON.stringify(noEnv.diagnostics));
  expect(noEnv.files["schema.sql"]).toBe(sql); // CLI generation has no runtime environment.

  for (const table of ["user", "session", "verification", "jwks", "oauthClient"]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
  expect(sql).not.toContain('INSERT INTO "oauthResource"');
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(sql); db.exec(sql);
  expect(db.query('SELECT identifier FROM "oauthResource"').all()).toEqual([]);
  expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'user'`).all()).toHaveLength(1);
});

test("field index names match Better Auth's own rule, including the hashed long form", async () => {
  // Test-only use of Better Auth's internal helper: production code reproduces it from public data.
  const { getDatabaseFieldIndexName } = await import("@better-auth/core/db/internal");
  const { fieldIndexName } = await import("../src/infrastructure/authSchema.js");
  for (const [table, column] of [["session", "userId"], ["oauthAccessToken", "a".repeat(80)], ["t".repeat(70), "c"]] as const)
    expect(fieldIndexName(table, column)).toBe(getDatabaseFieldIndexName(table, column, false));
});

test("CLI --auth reads authOptions(env) without constructing Better Auth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-auth-cli-"));
  try {
    const manifest = join(dir, "m.yaml");
    await writeFile(manifest, "apiVersion: cms.mantle.aotter.net/v2\nkind: Schema\nmetadata: {name: notes}\nspec:\n  title: Notes\n  lifecycle: operational\n  indexes: [[title]]\n  schema: {type: object, required: [title], properties: {title: {type: string}}}\n");
    const cli = new URL("../src/infrastructure/cli.ts", import.meta.url).pathname;
    execFileSync(process.execPath, [cli, "cloudflare-d1", join(dir, "out"), manifest, "--auth", new URL("apps/auth/auth.ts", import.meta.url).pathname], { cwd: dir, stdio: "pipe" });
    expect(await readFile(join(dir, "out/schema.sql"), "utf8")).toContain('CREATE TABLE IF NOT EXISTS "oauthClient"');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
