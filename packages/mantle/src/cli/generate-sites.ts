import { execFileSync } from "node:child_process";
import { access, readFile, readdir, mkdir, writeFile, appendFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { buildSqliteMigrationArtifact, renderSqliteManagedMigration } from "@aotter/mantle-runtime";
import type { SchemaManifest } from "@aotter/mantle-spec";
import { assertInsideProject, type ProjectSelection } from "./generate-project.js";

interface File { readonly path: string; readonly content: string; readonly owned?: boolean }
interface State {
  readonly fingerprint: string;
  readonly canonicalVersion: string;
  readonly schemas: readonly SchemaManifest[];
  readonly appliedMigrationIds: readonly string[];
  readonly lastIndex: number;
}

export async function prepareSites(root: string, output: string, selection: ProjectSelection, schemas: readonly SchemaManifest[], check: boolean): Promise<{
  readonly stale: boolean;
  readonly commit: () => Promise<void>;
}> {
  const has = (feature: string): boolean => selection.features.includes(feature as typeof selection.features[number]);
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "") || "mantle-site";
  const worker = resolve(root, output, "worker.ts");
  const indexImport = importPath(join(root, "src/index.ts"), worker);
  const files: File[] = [
    { path: worker, content: workerSource(root, worker, selection), owned: true },
    { path: "src/index.ts", content: `export { default } from "${indexImport}";\n` },
    { path: "src/handlers.ts", content: 'import type { AnyHandler } from "@aotter/mantle/runtime";\n\nexport const handlers: Record<string, AnyHandler> = {};\n' },
    { path: "scripts/build.mjs", content: await template("build.mjs") },
    { path: "tsconfig.json", content: `${JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true,
      noEmit: true, types: ["@cloudflare/workers-types"], lib: ["ES2022", "DOM"],
    }, include: ["src/**/*.ts", `${relative(root, resolve(root, output)).split(sep).join("/") || "."}/**/*.ts`] }, null, 2)}\n` },
    { path: ".dev.vars.example", content: "# Local simulation only. Configure the real owner and origin through Sites before publishing.\nOWNER_EMAIL=you@example.com\nPUBLIC_ORIGIN=http://127.0.0.1:4174\n" },
  ];
  if (has("web")) files.push({ path: "src/home.ts", content: 'export function home(): Response {\n  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Mantle</title><body><main></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });\n}\n' });
  if (has("admin")) {
    files.push({ path: "src/sites-auth.ts", content: await template("auth.ts") });
    files.push({ path: "src/sites-mcp.ts", content: await template("mcp.ts") });
    files.push({ path: "scripts/smoke-local.mjs", content: await template("smoke-local.mjs") });
  } else if (has("mcp")) {
    files.push({ path: "src/sites-env.ts", content: await template("env.ts") });
    files.push({ path: "src/sites-mcp.ts", content: await template("public-mcp.ts") });
  }
  const wrangler = await Promise.all(["wrangler.jsonc", "wrangler.json", "wrangler.toml"].map(async path => ({ path, content: await optional(join(root, path)) })));
  const existingWrangler = wrangler.filter(file => file.content !== null);
  if (existingWrangler.length > 1) throw new Error(`Multiple Wrangler configs found: ${existingWrangler.map(file => file.path).join(", ")}.`);
  let dbName = name;
  if (existingWrangler.length) {
    const config = existingWrangler[0]!;
    await assertInsideProject(root, join(root, config.path));
    if (!/dist\/server\/index\.js/.test(config.content!) || !/\bDB\b/.test(config.content!) || (has("admin") && !/\bASSETS\b/.test(config.content!))) {
      throw new Error(`Existing ${config.path} is preserved; configure the generated server, DB${has("admin") ? ", and ASSETS" : ""} before adoption.`);
    }
    const configuredName = config.content!.match(/\bdatabase_name["']?\s*[:=]\s*["']([^"']+)["']/)?.[1];
    if (!configuredName || !/\bmigrations_dir["']?\s*[:=]\s*["']drizzle["']/.test(config.content!)) {
      throw new Error(`Existing ${config.path} must name its D1 database and use migrations_dir=drizzle.`);
    }
    dbName = configuredName;
  } else {
    files.push({ path: "wrangler.jsonc", content: `${JSON.stringify({
      name, main: "dist/server/index.js", compatibility_date: "2026-09-08", workers_dev: false,
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      ...(has("admin") ? { assets: { directory: "dist/client", binding: "ASSETS", run_worker_first: true } } : {}),
      d1_databases: [{ binding: "DB", database_name: name, database_id: "local", migrations_dir: "drizzle" }],
    }, null, 2)}\n` });
  }
  const hosting = await optional(join(root, ".openai/hosting.json"));
  await assertInsideProject(root, join(root, ".openai/hosting.json"));
  if (hosting !== null) {
    if (JSON.parse(hosting).d1 !== "DB") throw new Error("Existing Sites hosting.json must bind D1 as DB; project metadata is preserved.");
  } else files.push({ path: ".openai/hosting.json", content: '{"d1":"DB"}\n' });
  const entry = await optional(join(root, "src/index.ts"));
  if (entry !== null && !entry.includes(indexImport)) throw new Error(`Existing src/index.ts must import ${indexImport} before adoption.`);
  const writes: File[] = [];
  for (const file of files) {
    const path = resolve(root, file.path);
    await assertInsideProject(root, path);
    const current = await optional(path);
    if (current !== null && file.owned && !current.startsWith("// Generated by `mantle generate`")) {
      throw new Error(`Generated output would replace a user-owned file: ${path}`);
    }
    if (current === null || (file.owned && current !== file.content)) writes.push(file);
  }
  const migration = await prepareMigration(root, dbName, schemas, has("admin"), check);
  const ignorePath = join(root, ".gitignore");
  const ignored = await optional(ignorePath);
  const ignoreMissing = !ignored?.split(/\r?\n/).includes(".dev.vars");
  return {
    stale: writes.length > 0 || migration.stale || ignoreMissing,
    commit: async () => {
      for (const file of writes) {
        const path = resolve(root, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content, { flag: file.owned ? "w" : "wx" });
      }
      if (ignoreMissing) {
        await assertInsideProject(root, ignorePath);
        if (ignored === null) await writeFile(ignorePath, "node_modules/\ndist/\n.wrangler/\n.dev.vars\n", { flag: "wx" });
        else await appendFile(ignorePath, `${ignored.endsWith("\n") ? "" : "\n"}.dev.vars\n`);
      }
      await migration.commit();
    },
  };
}

async function prepareMigration(root: string, dbName: string, schemas: readonly SchemaManifest[], admin: boolean, check: boolean) {
  const statePath = join(root, "drizzle/meta/mantle-state.json");
  const fingerprintPath = join(root, "src/storage-fingerprint.json");
  const journalPath = join(root, "drizzle/meta/_journal.json");
  for (const path of [statePath, fingerprintPath, journalPath]) await assertInsideProject(root, path);
  const current = await optional(statePath);
  const state = current ? JSON.parse(current) as State : null;
  const artifact = await buildSqliteMigrationArtifact(state?.schemas ?? [], schemas, { appliedMigrationIds: state?.appliedMigrationIds });
  if (state && artifact.sourceFingerprint !== state.fingerprint) throw new Error("Saved migration source fingerprint is invalid.");
  if (artifact.destructive) throw new Error("Destructive Schema change requires a reviewed migration; no file was written.");
  const fingerprint = await optional(fingerprintPath);
  const fingerprintDrift = Boolean(state && fingerprint !== `${JSON.stringify(state.fingerprint)}\n`);
  const changed = !state || artifact.migrations.length > 0 || artifact.sourceFingerprint !== artifact.targetFingerprint;
  if (!changed) return { stale: fingerprintDrift, commit: async () => {
    if (fingerprintDrift && !check) await writeFile(fingerprintPath, `${JSON.stringify(state!.fingerprint)}\n`);
  } };
  if (fingerprintDrift) throw new Error("Generated fingerprint and migration source disagree; finish or restore the pending migration first.");
  const index = (state?.lastIndex ?? -1) + 1;
  const tag = `${String(index).padStart(4, "0")}_mantle`;
  const sqlPath = join(root, "drizzle", `${tag}.sql`);
  const journalText = await optional(journalPath);
  const journal = journalText ? JSON.parse(journalText) as { entries?: Array<{ idx: number; tag: string }> } : null;
  for (const path of [statePath, fingerprintPath, sqlPath, journalPath]) await assertInsideProject(root, path);
  const sql = `${!state && admin ? `CREATE TABLE sites_users (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT CHECK (role IN ('owner','editor','contributor') OR role IS NULL), signed_in INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));\n--> statement-breakpoint\n` : ""}${renderSqliteManagedMigration(artifact, state ? { canonicalVersion: state.canonicalVersion } : undefined)}`;
  const existingSql = await optional(sqlPath);
  if (existingSql !== null && existingSql !== sql) throw new Error(`Migration file already exists with different SQL: ${sqlPath}`);
  const last = journal?.entries?.at(-1);
  const journalAhead = last?.idx === index && last.tag === tag && existingSql === sql;
  if (state && !journalAhead && last?.idx !== state.lastIndex) throw new Error("Sites migration journal does not match saved state.");
  if (!state && journalText !== null && !journalAhead) throw new Error("Existing D1 migration journal cannot be adopted without Mantle state.");
  const migrationFiles = await readdir(join(root, "drizzle")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (!state && migrationFiles.some(file => file.endsWith(".sql") && file !== `${tag}.sql`)) throw new Error("Existing D1 migrations cannot be adopted without Mantle state.");
  const nextState: State = { fingerprint: artifact.targetFingerprint, canonicalVersion: artifact.targetCanonicalVersion, schemas,
    appliedMigrationIds: [...new Set([...(state?.appliedMigrationIds ?? []), ...artifact.migrations.map(({ id }) => id)])], lastIndex: index };
  const nextJournal = { version: "7", dialect: "sqlite", entries: [...(journal?.entries ?? []), {
    idx: index, version: "6", when: Date.now(), tag, breakpoints: true,
  }] };
  return {
    stale: true,
    commit: async () => {
      if (check) return;
      if (state) await verifyLocalD1(root, dbName, state);
      await mkdir(dirname(sqlPath), { recursive: true });
      await mkdir(dirname(journalPath), { recursive: true });
      await mkdir(dirname(fingerprintPath), { recursive: true });
      if (existingSql === null) await writeFile(sqlPath, sql, { flag: "wx" });
      if (!journalAhead) await writeFile(journalPath, `${JSON.stringify(nextJournal)}\n`, { flag: journalText === null ? "wx" : "w" });
      await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
      await writeFile(fingerprintPath, `${JSON.stringify(artifact.targetFingerprint)}\n`);
    },
  };
}

async function verifyLocalD1(root: string, dbName: string, state: State): Promise<void> {
  const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
  await access(wrangler).catch(() => { throw new Error("Install the generated project dependencies before verifying local D1 migrations."); });
  const query = (sql: string): unknown[] => {
    const output = execFileSync(process.execPath, [wrangler, "d1", "execute", dbName, "--local", "--command", sql, "--json"], { cwd: root, encoding: "utf8" });
    return (JSON.parse(output) as Array<{ results: unknown[] }>)[0]?.results ?? [];
  };
  const active = query("SELECT fingerprint FROM _mantle_storage_state WHERE id=1")[0] as { fingerprint?: string } | undefined;
  if (active?.fingerprint !== state.fingerprint) throw new Error("Local D1 has a pending migration. Apply it before generating another migration.");
  const table = query("SELECT name FROM sqlite_schema WHERE type='table' AND name='_mantle_managed_runtime_state'")[0];
  const version = table ? (query("SELECT canonical_version FROM _mantle_managed_runtime_state WHERE id=1")[0] as { canonical_version?: string } | undefined)?.canonical_version : undefined;
  if (version !== state.canonicalVersion) throw new Error("Local D1 runtime version does not match the applied migration state.");
}

async function optional(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function template(name: string): Promise<string> {
  return readFile(new URL(`../../templates/chatgpt-sites/${name}`, import.meta.url), "utf8");
}

function importPath(from: string, to: string): string {
  const path = relative(dirname(from), to).split(sep).join("/").replace(/\.ts$/, ".js");
  return path.startsWith(".") ? path : `./${path}`;
}

function workerSource(root: string, worker: string, selection: ProjectSelection): string {
  const has = (feature: string): boolean => selection.features.includes(feature as typeof selection.features[number]);
  const from = (path: string): string => importPath(worker, join(root, path));
  const admin = has("admin");
  const mcp = has("mcp");
  return `// Generated by \`mantle generate\`. Edit src/home.ts and src/handlers.ts instead.\n` +
    `import { Hono } from "hono";\n` +
    `import { bootMantleRuntime, SqliteMantleStorageAdapter${has("api") ? ", createMantleRequestHandler" : ""}, type MantleRuntime } from "@aotter/mantle/runtime";\n` +
    `import { D1DatabaseDriver${admin ? ", AssetsAssetServer" : ""} } from "@aotter/mantle/cloudflare";\n` +
    (admin ? `import { mountMantleAdmin, type MantleAdminRuntime } from "@aotter/mantle/admin";\n` : "") +
    `import { plan } from "./mantle.js";\n` +
    `import { handlers } from "${from("src/handlers.ts")}";\n` +
    `import fingerprint from "${from("src/storage-fingerprint.json")}";\n` +
    (has("web") ? `import { home } from "${from("src/home.ts")}";\n` : "") +
    (admin ? `import { createChatGPTAuth, type Env } from "${from("src/sites-auth.ts")}";\n` :
      mcp ? `import type { Env } from "${from("src/sites-env.ts")}";\n` : `interface Env { DB: D1Database; PUBLIC_ORIGIN: string; ASSETS?: Fetcher }\n`) +
    (mcp ? `import { ${admin ? "mountMcp" : "mountPublicMcp"} } from "${from("src/sites-mcp.ts")}";\n` : "") +
    `\nfunction assemble(env: Env) {\n` +
    `  if (!env.PUBLIC_ORIGIN) throw new Error("Set PUBLIC_ORIGIN to the exact Sites origin.");\n` +
    (admin ? `  if (!env.ASSETS) throw new Error("Sites Admin requires the ASSETS binding.");\n  const auth = createChatGPTAuth(env);\n` : "") +
    `  let runtime: Promise<${admin ? "MantleAdminRuntime" : "MantleRuntime"}> | undefined;\n` +
    `  const get = () => runtime ??= bootMantleRuntime({\n    plan, handlers,\n    storage: new SqliteMantleStorageAdapter(new D1DatabaseDriver(env.DB), { brand: "Mantle", title: "Mantle", origin: env.PUBLIC_ORIGIN }, { managedStorageFingerprint: fingerprint }),\n  })` +
    (admin ? `.then(value => {\n    if (!value.siteConfig || !value.updateSiteSettings) throw new Error("Admin storage unavailable.");\n    return value as MantleAdminRuntime;\n  })` : "") +
    `.catch(error => { runtime = undefined; throw error; });\n` +
    `  const app = new Hono<{ Bindings: Env }>();\n` +
    `  app.use("*", async (c, next) => { await next(); if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "private, no-store"); c.header("X-Content-Type-Options", "nosniff"); });\n` +
    (has("web") ? `  app.get("/", () => home());\n` : "") +
    `  app.get("/health", async () => { await get(); return Response.json({ ok: true, storage: "D1", auth: "ChatGPT Sites" }); });\n` +
    (mcp ? `  ${admin ? "mountMcp(app, get, auth, plan)" : "mountPublicMcp(app, get, plan)"};\n` : "") +
    (admin ? `  app.get("/admin/sign-in", async c => {\n    if (c.req.header("cookie")?.split(";").some(value => value.trim() === "mantle-sites-signout=1")) {\n      c.header("Set-Cookie", "mantle-sites-signout=; Path=/admin/sign-in; HttpOnly; SameSite=Strict; Max-Age=0" + (env.PUBLIC_ORIGIN.startsWith("https:") ? "; Secure" : ""));\n      return c.redirect("/signout-with-chatgpt?return_to=%2F");\n    }\n    return c.redirect(await auth.getSession(c.req.raw) ? "/admin" : "/signin-with-chatgpt?return_to=%2Fadmin");\n  });\n  app.use("/admin/*", async (c, next) => {\n    if (!c.req.path.startsWith("/admin/api/") && !await auth.getSession(c.req.raw)) return c.redirect("/signin-with-chatgpt?return_to=%2Fadmin");\n    await next();\n  });\n  mountMantleAdmin(app, { plan, auth, get, assets: new AssetsAssetServer(env.ASSETS), mcpEndpoints: { public: "/api/mcp", staff: "/api/mcp/staff" }, requestContext: c => ({ env: c.env, waitUntil: promise => c.executionCtx.waitUntil(promise) }) });\n  app.get("/_mantle/*", c => env.ASSETS!.fetch(c.req.raw));\n` : "") +
    (has("api") ? `  const api = createMantleRequestHandler({ plan, getRuntime: get });\n  app.use("*", async (c, next) => {\n    const response = await api(c.req.raw, { user: null, staff: null, env: c.env, waitUntil: promise => c.executionCtx.waitUntil(promise) });\n    if (response) return response;\n    await next();\n  });\n` : "") +
    `  app.onError(error => { console.error("Mantle request failed", error); return Response.json({ error: "internal_error" }, { status: 500, headers: { "Cache-Control": "private, no-store" } }); });\n` +
    `  return app;\n}\n\nlet app: ReturnType<typeof assemble> | undefined;\nexport default { fetch(request: Request, env: Env, ctx: ExecutionContext) { return (app ??= assemble(env)).fetch(request, env, ctx); } };\n`;
}
