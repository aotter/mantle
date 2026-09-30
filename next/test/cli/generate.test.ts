import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runGenerate } from "../../src/cli/generate.js";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import type { DatabaseDriver } from "../../src/core/driver.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/app", import.meta.url));
const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const TYPES = fileURLToPath(new URL("../../node_modules/@types", import.meta.url));

/** A copy of the fixture with the named packages "installed" (a package.json under node_modules is what generate looks for). */
async function project(packages: readonly string[] = ["@aotter/mantle"], lockfile?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantle-generate-"));
  await cp(FIXTURE, dir, { recursive: true });
  for (const p of packages) {
    await mkdir(join(dir, "node_modules", p), { recursive: true });
    await writeFile(join(dir, "node_modules", p, "package.json"), `{ "name": "${p}" }`);
  }
  if (lockfile) await writeFile(join(dir, lockfile), "");
  return dir;
}

/** Run the command, returning its exit code and what it wrote. */
async function gen(args: readonly string[], cwd: string, driver?: DatabaseDriver) {
  let out = "";
  let err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => ((out += String(c)), true));
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => ((err += String(c)), true));
  try {
    return { code: await runGenerate(args, { cwd, ...(driver ? { driver } : {}) }), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");
const CUSTOM = ["--features", "web", "--identity", "custom"];

describe("mantle generate", () => {
  it("writes byte-identical plan.json and mantle.ts for identical input, whatever the project's location", async () => {
    const [a, b] = [await project(), await project()];
    expect((await gen(CUSTOM, a)).code).toBe(0);
    expect((await gen(CUSTOM, b)).code).toBe(0);
    for (const f of [".mantle/generated/plan.json", ".mantle/generated/mantle.ts", "mantle.config.json"]) expect(await read(a, f)).toBe(await read(b, f));
    const planJson = await read(a, ".mantle/generated/plan.json");
    expect(planJson.endsWith("}\n")).toBe(true);
    const { sourceHash, plan } = JSON.parse(planJson);
    expect(sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(plan)).toEqual([...Object.keys(plan)].sort());
    expect(JSON.parse(await read(a, "mantle.config.json"))).toEqual({ version: 2, identity: "custom", features: ["web"] });
    // a rerun rewrites nothing, and the source hash is not part of the fingerprint
    expect((await gen([], a)).code).toBe(0);
    expect(await read(a, ".mantle/generated/plan.json")).toBe(planJson);
    await writeFile(join(a, "manifests/items.yaml"), `# a comment\n${await read(a, "manifests/items.yaml")}`);
    expect((await gen([], a)).code).toBe(0);
    const next = JSON.parse(await read(a, ".mantle/generated/plan.json"));
    expect(next.sourceHash).not.toBe(sourceHash);
    expect(next.plan.fingerprint).toBe(plan.fingerprint);
  });

  it("--check exits 1 on stale output and writes nothing, and 0 once generated", async () => {
    const dir = await project();
    const missing = await gen(["--check", ...CUSTOM], dir);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("stale: .mantle/generated/plan.json");
    await expect(read(dir, "mantle.config.json")).rejects.toThrow();
    expect((await gen(CUSTOM, dir)).code).toBe(0);
    expect((await gen(["--check"], dir)).code).toBe(0);
    const before = await read(dir, ".mantle/generated/mantle.ts");
    await writeFile(join(dir, "manifests/procedures.yaml"), (await read(dir, "manifests/procedures.yaml")).replace("handler: { ref: note }", "handler: { ref: noteV2 }"));
    const stale = await gen(["--check"], dir);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("stale: .mantle/generated/mantle.ts");
    expect(await read(dir, ".mantle/generated/mantle.ts")).toBe(before);
  });

  it("names the View row's output columns; a Schema star is its declared fields without the scope field", async () => {
    const dir = await project();
    await gen(CUSTOM, dir);
    const mod = await read(dir, ".mantle/generated/mantle.ts");
    expect(mod).toContain('export type ViewRow_my_u002d_items = { readonly "id": unknown; readonly "label": unknown; readonly "stock": unknown; };');
    expect(mod).toContain('export type ViewRow_all_u002d_items = { readonly "name": unknown; readonly "stock": unknown; };');
  });

  it("refuses a missing feature dependency with the install command, and writes nothing", async () => {
    const dir = await project(["@aotter/mantle"], "pnpm-lock.yaml");
    const r = await gen([], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain("GENERATE_FEATURE_DEPENDENCY_MISSING identity 'mantle': identity 'mantle' needs better-auth, which is not installed. Run `pnpm add better-auth`");
    expect(r.err).toContain("feature 'mcp' needs @modelcontextprotocol/server, which is not installed. Run `pnpm add @modelcontextprotocol/server`");
    expect(r.err).toContain("feature 'admin' needs @aotter/mantle-ui");
    await expect(read(dir, ".mantle/generated/plan.json")).rejects.toThrow();
    // an explicit --features without --identity is `none`, and admin then needs an identity: never re-added, never installed
    const none = await gen(["--features", "admin"], await project(["@aotter/mantle", "@aotter/mantle-ui"]));
    expect(none.code).toBe(1);
    expect(none.err).toContain("feature 'admin' needs a caller identity, and identity is 'none'");
    const npm = await gen([], await project([]));
    expect(npm.err).toContain("Run `npm install @aotter/mantle`");
    expect((await gen([], await project(["@aotter/mantle", "better-auth", "@modelcontextprotocol/server", "@aotter/mantle-ui"]))).code).toBe(0);
  });

  it("refuses to switch identity on a rerun", async () => {
    const dir = await project();
    await gen(CUSTOM, dir);
    const r = await gen(["--identity", "mantle"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Switching identity from 'custom' to 'mantle' on a rerun is refused");
  });

  it("names mantle-update for a v1 manifest and a v1 config", async () => {
    const v1 = await project();
    await writeFile(join(v1, "manifests/items.yaml"), (await read(v1, "manifests/items.yaml")).replace("cms.mantle.aotter.net/v2", "cms.mantle.aotter.net/v1"));
    const m = await gen(CUSTOM, v1);
    expect(m.code).toBe(1);
    expect(m.err).toContain("run mantle-update");
    const c = await project();
    await writeFile(join(c, "mantle.config.json"), JSON.stringify({ version: 1, host: "cf", features: ["spec", "runtime"] }));
    const r = await gen([], c);
    expect(r.code).toBe(2);
    expect(r.err).toContain("run mantle-update");
  });
});

describe("the generated module type-checks against Core", () => {
  const compile = async (dir: string) => {
    const program = ts.createProgram([join(dir, "src/service.ts")], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2023.d.ts"], types: ["node"], typeRoots: [TYPES], resolveJsonModule: true, skipLibCheck: true, noUncheckedIndexedAccess: true,
      paths: { "@aotter/mantle": [join(SRC, "core/index.ts")], "@aotter/mantle/spec": [join(SRC, "spec/index.ts")] },
    });
    return ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? d.file.fileName.slice(dir.length) : ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  };
  let dir: string;
  let handlers: string;
  beforeAll(async () => {
    dir = await project();
    await gen(CUSTOM, dir);
    handlers = await read(dir, "src/handlers.ts");
  });

  it("accepts exactly the plan's refs, a typed ctx.store, and the handlers in createMantle", async () => {
    expect(await compile(dir)).toEqual([]);
  }, 60_000);

  it("a missing ref is an error", async () => {
    await writeFile(join(dir, "src/handlers.ts"), handlers.replace(/  note: .*\n/, ""));
    expect((await compile(dir)).join("\n")).toMatch(/Property '"?note"?' is missing/);
  }, 60_000);

  it("an extra ref is an error", async () => {
    await writeFile(join(dir, "src/handlers.ts"), handlers.replace("  note:", "  extra: () => ({}),\n  note:"));
    expect((await compile(dir)).join("\n")).toMatch(/'extra' does not exist in type 'MantleHandlers/);
  }, 60_000);

  it("a plan without refs takes no handler", async () => {
    const bare = await project();
    await writeFile(join(bare, "manifests/procedures.yaml"), (await read(bare, "manifests/procedures.yaml")).split("\n---\n")[0]!);
    await gen(CUSTOM, bare);
    await writeFile(join(bare, "src/handlers.ts"), 'import type { MantleHandlers } from "../.mantle/generated/mantle.js";\nexport const handlers: MantleHandlers = { extra: () => ({}) };\n');
    expect((await compile(bare)).join("\n")).toMatch(/not assignable to type 'never'/);
  }, 60_000);

  it("a View's required input, an unknown Schema and a written scope field are errors", async () => {
    await writeFile(join(dir, "src/handlers.ts"), handlers.replace('{ input: { min: 1 }, limit: 10 }', "{ limit: 10 }").replace('from: "items"', 'from: "nope"').replace('values: { name:', 'values: { owner: "x", name:'));
    const errors = (await compile(dir)).join("\n");
    expect(errors).toMatch(/Property 'input' is missing/);
    expect(errors).toMatch(/"nope"/);
    expect(errors).toMatch(/'owner' does not exist/); // Store fills the scope field; a write may not name it
  }, 60_000);
});

describe("mantle generate --check storage dry-run", () => {
  let d1: LocalD1;
  beforeAll(async () => { d1 = await LocalD1.create(); });
  afterAll(async () => { await d1.dispose(); });
  const objects = () => d1.all("SELECT type, name, sql FROM sqlite_schema ORDER BY name");

  it("prints the SQL convergence would run and leaves the database unchanged", async () => {
    const dir = await project();
    await gen(CUSTOM, dir);
    await objects(); // local D1 creates its own metadata table on first use
    const before = await objects();
    const r = await gen(["--check"], dir, d1);
    expect(r.code).toBe(0);
    expect(r.out).toContain("CREATE TABLE IF NOT EXISTS _mantle_schema_tables (name TEXT PRIMARY KEY) STRICT;");
    expect(r.out).toContain('CREATE TABLE IF NOT EXISTS "items" (');
    expect(r.out).toContain("INSERT OR IGNORE INTO _mantle_schema_tables (name) VALUES ('items');");
    expect(await objects()).toEqual(before);
  });

  it("reads a SQLite file read-only with --database", async () => {
    const dir = await project();
    await gen(CUSTOM, dir);
    const { DatabaseSync } = await import("node:sqlite");
    const file = join(dir, "local.sqlite");
    new DatabaseSync(file).exec("CREATE TABLE items (id TEXT)");
    const bytes = await readFile(file);
    const r = await gen(["--check", "--database", "local.sqlite"], dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain("STORAGE_TABLE_NOT_OWNED items");
    expect(await readFile(file)).toEqual(bytes);
    await rm(file);
  });
});
