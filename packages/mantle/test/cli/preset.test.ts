/**
 * The service preset `mantle generate` writes once (ADR-0032 amendment "the service preset"): each identity typechecks against the
 * repo's source and boots on local D1 under Wrangler; the schedule gate that replaced `check:schedule-cf`; and the Worker bundle
 * carries no SQL compiler.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { unstable_startWorker } from "wrangler";
import { runGenerate } from "../../src/cli/generate.js";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const WRANGLER = realpathSync(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")));
const WORKERS_TYPES = join(dirname(createRequire(join(WRANGLER, "package.json")).resolve("@cloudflare/workers-types/package.json")), "index.d.ts");
const TYPES = fileURLToPath(new URL("../../node_modules/@types", import.meta.url));
const PEERS = ["better-auth", "@better-auth/oauth-provider", "@better-auth/mcp", "@better-auth/cimd", "@modelcontextprotocol/server", "@modelcontextprotocol/ext-apps", "@aotter/mantle-ui"];
const SUBPATHS = ["spec", "cloudflare", "web", "mcp", "admin", "auth", "postgres"];
/** The repo's own `pg` and its types, linked into a project whose preset reads PostgreSQL through Hyperdrive. */
const NODE_MODULES = fileURLToPath(new URL("../../node_modules", import.meta.url));
const PG_URL = process.env.MANTLE_PG_URL;

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: ticks }
spec:
  title: Ticks
  lifecycle: operational
  schema: { type: object, required: [kind, causeId], properties: { kind: { type: string }, causeId: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: ticks }
spec: { surface: public, sql: "SELECT t.kind, t.causeId FROM ticks t ORDER BY t.kind" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: tick }
spec: { input: { type: object }, output: { type: object }, handler: { ref: tick } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: daily-tick }
spec: { source: { kind: schedule, cron: "0 2 * * 1" }, target: { procedure: tick } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: paused }
spec: { source: { kind: schedule, cron: "0 0 1 * 1", enabled: false }, target: { procedure: tick } }
`;

/** Records each run, and one more row from ctx.waitUntil, which the entry backs with cloudflare:workers' waitUntil. */
const TICK = `import type { MantleHandlers } from "../.mantle/generated/mantle.js";
export const handlers: MantleHandlers = {
  tick: async (_input, ctx) => {
    await ctx.store.write([{ insert: "ticks", values: { kind: ctx.cause.kind, causeId: ctx.cause.id } }]);
    ctx.waitUntil(ctx.store.write([{ insert: "ticks", values: { kind: "background", causeId: ctx.cause.id } }]));
    return {};
  },
};
`;

async function generate(dir: string, args: readonly string[]) {
  let out = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => ((out += String(c)), true));
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => ((out += String(c)), true));
  try {
    return { code: await runGenerate(args, { cwd: dir }), out };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

/** A project whose `@aotter/mantle` is this repo's source, with subpath exports, as Wrangler and generate resolve it. */
async function project(args: readonly string[], before: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantle-preset-"));
  await mkdir(join(dir, "manifests"));
  await writeFile(join(dir, "manifests/app.yaml"), MANIFESTS);
  for (const [path, text] of Object.entries(before)) await writeFile(join(dir, path), text);
  const pkg = join(dir, "node_modules/@aotter/mantle");
  await mkdir(pkg, { recursive: true });
  await symlink(SRC, join(pkg, "src"));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@aotter/mantle", type: "module", exports: { ".": "./src/core/index.ts", ...Object.fromEntries(SUBPATHS.map((s) => [`./${s}`, `./src/${s}/index.ts`])) } }));
  for (const p of PEERS) {
    await mkdir(join(dir, "node_modules", p), { recursive: true });
    await writeFile(join(dir, "node_modules", p, "package.json"), `{ "name": "${p}" }`);
  }
  await symlink(realpathSync(join(NODE_MODULES, "pg")), join(dir, "node_modules/pg"));
  await mkdir(join(dir, "node_modules/@types"), { recursive: true });
  await symlink(realpathSync(join(NODE_MODULES, "@types/pg")), join(dir, "node_modules/@types/pg"));
  // a stand-in for the built Admin SPA, where the preset's wrangler.jsonc binds it
  await mkdir(join(dir, "node_modules/@aotter/mantle-ui/dist/admin/assets"), { recursive: true });
  await writeFile(join(dir, "node_modules/@aotter/mantle-ui/dist/admin/index.html"), "<!doctype html><title>Mantle Admin</title>");
  await writeFile(join(dir, "node_modules/@aotter/mantle-ui/dist/admin/assets/app.js"), "export {};");
  // and for the built MCP App the staff surface serves
  await mkdir(join(dir, "node_modules/@aotter/mantle-ui/dist/mcp-app"), { recursive: true });
  await writeFile(join(dir, "node_modules/@aotter/mantle-ui/dist/mcp-app/index.js"), 'export const mantleAppHtml = "<html><head></head><body>app</body></html>";');
  await writeFile(join(dir, "node_modules/@aotter/mantle-ui/dist/mcp-app/index.d.ts"), "export declare const mantleAppHtml: string;");
  await writeFile(join(dir, "node_modules/@aotter/mantle-ui/package.json"), JSON.stringify({ name: "@aotter/mantle-ui", type: "module", exports: { "./package.json": "./package.json", "./mcp-app": { types: "./dist/mcp-app/index.d.ts", import: "./dist/mcp-app/index.js" } } }));
  const r = await generate(dir, args);
  expect(r.code, r.out).toBe(0);
  return dir;
}

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");
const exists = (dir: string, path: string) => readFile(join(dir, path)).then(() => true, () => false);

/** The generated tsconfig.json, with `@aotter/mantle` mapped to the repo's source and workers-types from Wrangler's install. */
function typecheck(dir: string): string[] {
  const { config } = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
  const { options, fileNames } = ts.parseJsonConfigFileContent(config, ts.sys, dir);
  expect(options.types).toEqual(["@cloudflare/workers-types", "node"]); // resolved from Wrangler's and this repo's installs below
  const paths = { "@aotter/mantle": [join(SRC, "core/index.ts")], "@aotter/mantle/*": [join(SRC, "*/index.ts")] };
  const program = ts.createProgram([...fileNames, WORKERS_TYPES], { ...options, types: ["node"], typeRoots: [TYPES], paths });
  return ts.getPreEmitDiagnostics(program).map((d) => `${d.file?.fileName ?? ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

/** The inputs of the bundle Wrangler would deploy. */
async function bundle(dir: string): Promise<string[]> {
  await promisify(execFile)(process.execPath, [join(WRANGLER, "bin/wrangler.js"), "deploy", "--dry-run", "--outdir", "dist", "--metafile", "dist/meta.json"], { cwd: dir });
  const inputs = Object.keys(JSON.parse(await read(dir, "dist/meta.json")).inputs as Record<string, unknown>);
  expect(inputs.some((p) => p.includes("src/core/createMantle.ts"))).toBe(true);
  return inputs;
}

async function boot(dir: string) {
  const worker = await unstable_startWorker({ config: join(dir, "wrangler.jsonc"), dev: { persist: join(dir, ".wrangler/state"), logLevel: "none", watch: false, inspector: false, server: { port: 0 } } });
  await worker.ready;
  return worker;
}
type Worker = Awaited<ReturnType<typeof boot>>;
const get = (w: Worker, path: string) => w.fetch(`http://127.0.0.1:8787${path}`);
const rows = async (w: Worker) => ((await (await get(w, "/api/views/ticks")).json()) as { rows: { kind: string; causeId: string }[] }).rows;

/** Every table of the project's local D1 databases. */
async function tables(dir: string): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const d1 = join(dir, ".wrangler/state/v3/d1");
  const files = (await readdir(d1, { recursive: true })).filter((f) => f.endsWith(".sqlite"));
  return files.flatMap((f) => {
    const db = new DatabaseSync(join(d1, f), { readOnly: true });
    try {
      return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    } finally {
      db.close();
    }
  });
}

describe("the service preset", () => {
  it("identity none: anonymous only, no auth tables, no Admin; files written once; the schedule gate", async () => {
    const dir = await project(["--features", "mcp"], { ".gitignore": "mine\n" });
    for (const f of ["src/service.ts", "src/handlers.ts", "src/index.ts", "wrangler.jsonc"]) expect(await exists(dir, f)).toBe(true);
    expect(await exists(dir, "src/identity.ts")).toBe(false);
    expect(await exists(dir, ".dev.vars.example")).toBe(false);
    // an existing file is never overwritten, not even the first time
    expect(await read(dir, ".gitignore")).toBe("mine\n");
    const service = await read(dir, "src/service.ts");
    expect(service).not.toContain("@aotter/mantle/auth");
    expect(service).not.toContain("/admin");
    expect(service).not.toContain("/mcp/staff"); // nobody can be staff without an identity
    expect(await read(dir, "src/handlers.ts")).toContain('throw new Error("not implemented: tick")');
    const { crons } = JSON.parse(await read(dir, "wrangler.jsonc")).triggers;
    expect(crons).toEqual(["0 2 * * 2"]); // Monday: POSIX 1, Cloudflare 2

    // a rerun and --check leave the application's files alone
    await writeFile(join(dir, "src/index.ts"), `// mine\n${await read(dir, "src/index.ts")}`);
    expect((await generate(dir, [])).code).toBe(0);
    const check = await generate(dir, ["--check"]);
    expect(check.code).toBe(0);
    expect(check.out).toBe("");
    expect(await read(dir, "src/index.ts")).toMatch(/^\/\/ mine\n/);

    expect(typecheck(dir)).toEqual([]);

    await writeFile(join(dir, "src/handlers.ts"), TICK);
    const worker = await boot(dir);
    try {
      expect(await rows(worker)).toEqual([]);
      expect((await get(worker, "/admin")).status).toBe(404);
      const fire = (time: number) => get(worker, `/cdn-cgi/local/scheduled?cron=${encodeURIComponent(crons[0])}&time=${time}`);
      const time = Date.UTC(2026, 9, 5, 2);
      const first = await fire(time);
      expect(first.status, await first.text()).toBe(200);
      await vi.waitFor(async () => expect((await rows(worker)).length).toBe(2), { timeout: 5_000 });
      expect(await rows(worker)).toEqual([{ kind: "background", causeId: `daily-tick:${time}` }, { kind: "schedule", causeId: `daily-tick:${time}` }]);
      // a replay of the same scheduledTime carries the same cause id, so a handler can deduplicate it
      expect((await fire(time)).status).toBe(200);
      await vi.waitFor(async () => expect((await rows(worker)).length).toBe(4), { timeout: 5_000 });
      expect((await rows(worker)).filter((r) => r.kind === "schedule")).toEqual([{ kind: "schedule", causeId: `daily-tick:${time}` }, { kind: "schedule", causeId: `daily-tick:${time}` }]);
      // a cron no Trigger maps to fails, never silently
      expect((await get(worker, `/cdn-cgi/local/scheduled?cron=${encodeURIComponent("0 2 * * 1")}`)).status).toBe(500);
    } finally {
      await worker.dispose();
    }
    const names = await tables(dir);
    expect(names).toContain("ticks");
    expect(names.filter((t) => ["user", "session", "account", "verification"].includes(t))).toEqual([]);
  }, 180_000);

  it("dialect postgres: Hyperdrive wiring typechecks, and on PostgreSQL the Worker converges, serves Views and signs in", async () => {
    const dir = await project(["--dialect", "postgres"]);
    expect(JSON.parse(await read(dir, "mantle.config.json"))).toMatchObject({ dialect: "postgres" });
    expect(JSON.parse(await read(dir, ".mantle/generated/plan.json")).plan.dialect).toEqual({ name: "@aotter/mantle/postgres", version: "1" });
    const service = await read(dir, "src/service.ts");
    expect(service).toContain("postgresStorage({ connect: database(env).connect })");
    expect(service).toContain("database: pgPool(database(env).connect), driver: pgDatabaseDriver(database(env).connect)");
    // a request is the unit of work: one client for all of its queries; pipelining stays off until Hyperdrive is verified (#1379)
    expect(service).toContain("database(env).run(() => (routes ??= mount(runtime, env))(request, waitUntil))");
    expect(service).not.toMatch(/new pg\.Client\(\{[^}]*pipeline/);
    expect(service).not.toContain("D1Database");
    const wrangler = JSON.parse(await read(dir, "wrangler.jsonc"));
    expect(wrangler.d1_databases).toBeUndefined();
    expect(wrangler.hyperdrive).toEqual([expect.objectContaining({ binding: "HYPERDRIVE", id: "REPLACE_WITH_HYPERDRIVE_CONFIG_ID" })]);
    expect(typecheck(dir)).toEqual([]);
    // the placeholder id is reported on every run until it is replaced
    expect((await generate(dir, [])).out).toContain("Hyperdrive id is still the placeholder");
    // the engine is chosen once
    expect(await generate(dir, ["--dialect", "sqlite"])).toMatchObject({ code: 2, out: expect.stringContaining("Switching dialect") });
    if (!PG_URL) return;

    const pg = (await import("pg")).default;
    const name = `mantle_preset_${Date.now()}`;
    const admin = new pg.Client(PG_URL);
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    try {
      // reads run under the database's own limit, which boot checks (#1379)
      await admin.query(`ALTER DATABASE ${name} SET statement_timeout = '10s'`);
      const url = new URL(PG_URL);
      url.pathname = `/${name}`;
      await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ ...wrangler, hyperdrive: [{ ...wrangler.hyperdrive[0], localConnectionString: url.href }] }));
      await writeFile(join(dir, ".dev.vars"), (await read(dir, ".dev.vars.example")).replace("replace-with-a-random-32-byte-secret", "0123456789abcdef0123456789abcdef"));
      await writeFile(join(dir, "src/handlers.ts"), TICK);
      const worker = await boot(dir);
      try {
        expect(await rows(worker)).toEqual([]);
        expect((await get(worker, "/api/auth/methods")).status).toBe(200);
        expect((await get(worker, "/admin/api/me")).status).toBe(401);
        // Better Auth migrates on PostgreSQL on its first sign-in step
        const send = await worker.fetch("http://127.0.0.1:8787/api/auth/email-otp/send-verification-otp", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:8787" }, body: JSON.stringify({ email: "you@example.com", type: "sign-in" }) });
        expect(send.status, await send.text()).toBe(200);
      } finally {
        await worker.dispose();
      }
      const db = new pg.Client(url.href);
      await db.connect();
      const names = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
      await db.end();
      expect(names).toEqual(expect.arrayContaining(["ticks", "_mantle_boot_state", "user", "verification"]));
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 180_000);

  it("host none: only the plan and its types; no preset, no Cloudflare cron gate", async () => {
    const dir = await project(["--host", "none"]);
    for (const f of ["src/service.ts", "src/index.ts", "wrangler.jsonc"]) expect(await exists(dir, f)).toBe(false);
    expect(await exists(dir, ".mantle/generated/mantle.ts")).toBe(true);
    expect(JSON.parse(await read(dir, "mantle.config.json"))).toMatchObject({ host: "none" });
    expect(await generate(dir, ["--host", "cloudflare"])).toMatchObject({ code: 2, out: expect.stringContaining("Switching host") });
  });

  it("an enabled cron Cloudflare cannot run is refused before anything is written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mantle-preset-"));
    await mkdir(join(dir, "manifests"));
    await writeFile(join(dir, "manifests/app.yaml"), MANIFESTS.replace("enabled: false", "enabled: true"));
    await mkdir(join(dir, "node_modules/@aotter/mantle"), { recursive: true });
    await writeFile(join(dir, "node_modules/@aotter/mantle/package.json"), "{}");
    const r = await generate(dir, ["--features", ""]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("Trigger paused: Cannot map the cron '0 0 1 * 1' to Cloudflare: restrict the day of month or the weekday, not both\n");
    expect(await readdir(dir)).toEqual(["manifests", "node_modules"]);
  });

  it.each([
    [["--features", "admin", "--identity", "mantle"]],
    [["--features", "mcp", "--identity", "custom"]],
    [["--features", ""]],
  ])("the preset for %j typechecks", async (args) => {
    expect(typecheck(await project(args))).toEqual([]);
  }, 60_000);

  it("the typed Store's view takes search and filters, as Store does (ADR-0032 decision 5)", async () => {
    const dir = await project(["--features", ""]);
    await writeFile(join(dir, "src/handlers.ts"), `import type { MantleHandlers } from "../.mantle/generated/mantle.js";
export const handlers: MantleHandlers = {
  tick: async (_input, ctx) => {
    await ctx.store.view("ticks", { search: "a", filters: { kind: "b" }, limit: 10 });
    // @ts-expect-error a filter compares one scalar
    await ctx.store.view("ticks", { filters: { kind: { b: 1 } } });
    return {};
  },
};
`);
    expect(typecheck(dir)).toEqual([]);
  }, 60_000);

  it("identity custom: the resolver stub fails loudly until the application fills it", async () => {
    const dir = await project(["--features", "admin", "--identity", "custom"]);
    const identity = await read(dir, "src/identity.ts");
    expect(identity).toContain("TODO(mantle)");
    expect(typecheck(dir)).toEqual([]);
    let worker = await boot(dir);
    try {
      // the resolver's error surfaces (Cloudflare answers 500); the request is never answered as anonymous
      await expect(get(worker, "/api/views/ticks")).rejects.toThrow("resolveCaller is not implemented");
    } finally {
      await worker.dispose();
    }
    await writeFile(join(dir, "src/identity.ts"), 'import type { CallerResolver } from "@aotter/mantle";\nexport const resolveCaller: CallerResolver = async () => ({ caller: { kind: "anonymous" } });\n');
    expect(typecheck(dir)).toEqual([]);
    // custom keeps the service's own users: no auth package reaches the Worker
    expect((await bundle(dir)).filter((p) => /better-auth|src\/auth\//.test(p))).toEqual([]);
    worker = await boot(dir);
    try {
      expect(await rows(worker)).toEqual([]);
      expect((await get(worker, "/admin/api/me")).status).toBe(401); // Admin is mounted, and refuses an anonymous caller
    } finally {
      await worker.dispose();
    }
  }, 180_000);

  it("identity mantle with every feature: auth routes, REST and Admin boot; the Worker bundle has no libpg-query", async () => {
    const dir = await project([]);
    expect(await read(dir, ".dev.vars.example")).toContain("BETTER_AUTH_SECRET=");
    expect(typecheck(dir)).toEqual([]);

    await writeFile(join(dir, ".dev.vars"), (await read(dir, ".dev.vars.example")).replace("replace-with-a-random-32-byte-secret", "0123456789abcdef0123456789abcdef"));
    const worker = await boot(dir);
    try {
      const methods = await get(worker, "/api/auth/methods");
      expect(methods.status).toBe(200);
      expect(await methods.json()).toEqual({ methods: [expect.objectContaining({ kind: "email-otp" })] });
      expect(await rows(worker)).toEqual([]);
      expect((await get(worker, "/admin/api/me")).status).toBe(401);
      // the staff MCP surface has its own mount, before /mcp: anonymous is challenged toward the /mcp resource
      const mcp = (path: string) => worker.fetch(`http://127.0.0.1:8787${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
      const staff = await mcp("/mcp/staff");
      expect([staff.status, staff.headers.get("www-authenticate")]).toEqual([401, expect.stringContaining("/.well-known/oauth-protected-resource/mcp")]);
      expect((await mcp("/mcp")).status).toBe(200);
      expect(await read(dir, "src/service.ts")).toContain('apps: { resources: [planApp(runtime.plan, { surface: "staff", html: mantleAppHtml })] }');
      // the SPA from @aotter/mantle-ui/admin: the shell for any route, with Admin's frame refusal; a file by name; no missing file
      for (const path of ["/admin", "/admin/c/items"]) {
        const shell = await get(worker, path);
        expect([shell.status, await shell.text(), shell.headers.get("x-frame-options")]).toEqual([200, "<!doctype html><title>Mantle Admin</title>", "DENY"]);
      }
      expect(await (await get(worker, "/admin/assets/app.js")).text()).toBe("export {};");
      expect((await get(worker, "/admin/assets/missing.js")).status).toBe(404);
      // the Worker answers first: the files are not served at their bare paths
      expect((await get(worker, "/index.html")).status).toBe(404);
    } finally {
      await worker.dispose();
    }

    // ADR-0034 decision 3: only the CLI parses SQL, so the Worker bundle has no compiler
    expect((await bundle(dir)).filter((p) => /libpg-query|spec\/infrastructure/.test(p))).toEqual([]);
  }, 180_000);

  it("an unset PUBLIC_ORIGIN is not local: a forged loopback Origin gets no one-time code", async () => {
    const dir = await project([]);
    await writeFile(join(dir, ".dev.vars"), "BETTER_AUTH_SECRET=0123456789abcdef0123456789abcdef\nADMIN_EMAIL=owner@example.com\n");
    const worker = await boot(dir);
    try {
      const res = await worker.fetch("http://127.0.0.1:8787/api/auth/email-otp/send-verification-otp", {
        method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:8787" }, body: JSON.stringify({ email: "owner@example.com", type: "sign-in" }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).toContain("not configured");
    } finally {
      await worker.dispose();
    }
  }, 180_000);

  it("generate warns, and never writes, when wrangler.jsonc crons or the selection drift from the plan", async () => {
    const dir = await project(["--features", ""]);
    const service = await read(dir, "src/service.ts");
    await writeFile(join(dir, "wrangler.jsonc"), (await read(dir, "wrangler.jsonc")).replace(/"crons": \[[^\]]*\]/, '"crons": ["5 5 * * *"]'));
    const before = await read(dir, "wrangler.jsonc");
    const r = await generate(dir, ["--features", "mcp"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("warning: wrangler.jsonc triggers.crons does not match");
    expect(r.out).toContain("warning: the selection changed but src/service.ts already exists");
    expect(await read(dir, "wrangler.jsonc")).toBe(before);
    expect(await read(dir, "src/service.ts")).toBe(service);
  }, 60_000);

  it("generate warns when Admin is selected and wrangler.jsonc binds no ASSETS", async () => {
    const dir = await project([]);
    const r0 = await generate(dir, []);
    expect(r0.out).not.toContain("binds no ASSETS");
    await writeFile(join(dir, "wrangler.jsonc"), (await read(dir, "wrangler.jsonc")).replace(/"binding": "ASSETS"/, '"binding": "FILES"'));
    expect((await generate(dir, [])).out).toContain("warning: wrangler.jsonc binds no ASSETS");
  }, 60_000);

  it("a write that fails midway exits 2 and the rerun finishes the preset", async () => {
    const dir = await project([]);
    await rm(join(dir, "src/service.ts"));
    await rm(join(dir, "wrangler.jsonc"));
    await chmod(dir, 0o555);
    const r = await generate(dir, []).finally(() => chmod(dir, 0o755));
    expect(r.code).toBe(2);
    expect(r.out).toContain("cannot write wrangler.jsonc (EACCES)");
    expect(await exists(dir, "src/service.ts")).toBe(false);
    expect((await generate(dir, [])).code).toBe(0);
    expect(await exists(dir, "src/service.ts")).toBe(true);
  }, 60_000);
});

// Bun owns native connections/assets; the composition still uses exactly the same createMantle service port.
it('writes Bun presets: node-postgres over PostgreSQL, bun:sqlite over SQLite, no Cloudflare imports', async () => {
  const { presetFiles } = await import('../../src/cli/preset.js');
  const plan = { schemas: {}, procedures: {}, triggers: {} } as any;
  for (const dialect of ['postgres', 'sqlite'] as const) for (const identity of ['mantle', 'custom', 'none'] as const) {
    const files = Object.fromEntries(presetFiles('/private/tmp/bun-preset', { host: 'bun', dialect, identity, features: identity === 'none' ? [] : ['admin'] }, plan));
    expect(files['wrangler.jsonc']).toBeUndefined();
    expect(files['src/service.ts']).not.toMatch(/@aotter\/mantle\/cloudflare|HYPERDRIVE|D1Database|Fetcher|from "bun"|Bun\.SQL|bunPg|bunPostgres/);
    // ADR-0039: node-postgres on every host, one client per request; bun:sqlite stays native
    if (dialect === 'postgres') {
      expect(files['src/service.ts']).toMatch(/from "@aotter\/mantle\/postgres"/);
      expect(files['src/service.ts']).toContain('requestScoped(');
      expect(files['src/service.ts']).not.toContain('@aotter/mantle/bun"');
    } else expect(files['src/service.ts']).toContain('bunSqliteStorage');
    expect(files['src/index.ts']).toContain('Bun.serve');
    expect(files['src/index.ts']).toContain('headers.delete("x-mantle-client-ip")');
    expect(files['src/index.ts']).toContain('while (pending.size)');
    expect(files['src/service.ts']).toContain('schedules: false');
    if (dialect === 'postgres') { expect(files['src/index.ts']).toContain('new pg.Pool('); expect(files['src/index.ts']).not.toMatch(/SQL\(|"bun";|prepare: false/); }
    expect(files['src/index.ts']).toContain('development: false');
    // the generated project typechecks against bun-types, with @aotter/mantle mapped to this repo's source
    const dir = await mkdtemp(join(tmpdir(), 'mantle-bun-preset-'));
    for (const [path, source] of Object.entries(files)) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), source); }
    await mkdir(join(dir, '.mantle/generated'), { recursive: true });
    await writeFile(join(dir, '.mantle/generated/mantle.ts'), 'import type { MantleHandlers as Handlers, RuntimePlan } from "@aotter/mantle";\nexport const plan = {} as RuntimePlan;\nexport type MantleHandlers<E = unknown> = Handlers<E>;\n');
    const { config } = ts.readConfigFile(join(dir, 'tsconfig.json'), ts.sys.readFile);
    const { options, fileNames } = ts.parseJsonConfigFileContent(config, ts.sys, dir);
    expect(options.types).toEqual(['bun-types', 'node']);
    const paths = { '@aotter/mantle': [join(SRC, 'core/index.ts')], '@aotter/mantle/*': [join(SRC, '*/index.ts')] };
    const program = ts.createProgram([...fileNames, join(NODE_MODULES, 'bun-types/index.d.ts')], { ...options, types: ['node'], typeRoots: [TYPES], paths });
    expect(ts.getPreEmitDiagnostics(program).map((d) => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`), `${dialect} ${identity}`).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

// #1325: with Admin, consent is Admin's page (createAuthRoutes answers /oauth/consent first with its plain one)
it("points oauthProvider.consentPage at Admin's consent page when the preset mounts Admin", async () => {
  const { presetFiles } = await import('../../src/cli/preset.js');
  const plan = { schemas: {}, procedures: {}, triggers: {} } as any;
  const service = (features: string[]) => Object.fromEntries(presetFiles('/private/tmp/consent-preset', { host: 'cloudflare', dialect: 'sqlite', identity: 'mantle', features }, plan))['src/service.ts'];
  expect(service(['admin', 'mcp'])).toContain('consentPage: "/admin/oauth/consent"');
  expect(service(['mcp'])).toContain('consentPage: "/oauth/consent"');
  expect(service(['mcp'])).not.toContain('/admin/oauth/consent');
});
