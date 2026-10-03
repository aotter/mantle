/**
 * The host service preset (ADR-0032 decision 6 and amendment "the service preset", ADR-0036): application-owned files
 * `mantle generate` writes once and never again, for either built-in dialect. Nothing here is compared by `--check`.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RuntimePlan } from "../spec/index.js";
import { toCloudflareCron } from "../spec/domain/service/CloudflareCron.js";

export interface PresetSelection {
  readonly host?: "cloudflare" | "bun" | "none";
  readonly identity: "mantle" | "custom" | "none";
  readonly features: readonly string[];
  /** Built-in SQLite or PostgreSQL dialect; the host owns its native binding. */
  readonly dialect: "sqlite" | "postgres";
}

/** The generated module, as `src/*.ts` imports it (a constant, so check:boundaries does not read it as this folder's import). */
const MODULE = "../.mantle/generated/mantle.js";
const OWNED = "// Written once by `mantle generate`; this file is yours now.";
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
/** `__proto__: fn` in an object literal sets the prototype instead of a handler, so it is computed. */
const key = (s: string) => (s === "__proto__" ? '["__proto__"]' : /^[A-Za-z_$][\w$]*$/.test(s) ? s : JSON.stringify(s));

function service({ identity, features, dialect, host }: PresetSelection): string {
  const postgres = dialect === "postgres";
  const bun = host === "bun";
  const localOrigin = bun ? "http://127.0.0.1:3000" : "http://127.0.0.1:8787";
  const localEnv = bun ? ".env" : ".dev.vars";
  const mcp = features.includes("mcp");
  // the staff surface needs someone to be staff, so it comes with an identity
  const staffMcp = mcp && identity !== "none";
  const admin = features.includes("admin");
  const mantle = identity === "mantle";
  const withEnv = mantle || admin;
  const core = ["createMantle", ...(identity === "none" ? [] : ["withCaller"]), "type MantleRuntime", "type MantleService", "type Surface"];
  const auth = mantle ? ["ConsoleEmailSender", "createAuthRoutes", "createCallerResolver", "createMantleAuth", "createSetupIncompleteAuth", "type MantleAuth"] : [];
  const env = [...(bun ? [postgres ? "  readonly SQL: SQL;" : "  readonly DB: Database;"] : postgres ? ["  /** PostgreSQL through Hyperdrive; `wrangler dev` connects to its localConnectionString. */", "  readonly HYPERDRIVE: { readonly connectionString: string };"] : ["  readonly DB: D1Database;"]), ...(admin ? ["  /** The Admin SPA's files (`@aotter/mantle-ui/admin`), bound in wrangler.jsonc. */", bun ? "  readonly ASSETS: (path: string) => Promise<Response | null>;" : "  readonly ASSETS: Fetcher;"] : []), ...(mantle ? ["  readonly BETTER_AUTH_SECRET?: string;", "  readonly PUBLIC_ORIGIN?: string;", "  readonly ADMIN_EMAIL?: string;"] : [])];
  const origin = mantle ? [`  const origin = env.PUBLIC_ORIGIN?.replace(/\\/+$/, "") ?? "${localOrigin}";`, "  const auth = createAuth(env, origin);"] : [];
  const caller = mantle
    ? [`  const resolver = createCallerResolver(auth${mcp ? ", { jwtBearer: { audience: `${origin}/mcp`, scopes: [\"mcp\"] } }" : ""});`, "  const authRoutes = createAuthRoutes(auth, { resolver });", "  const guard = (surface: Surface, options?: { resourceMetadata?: string }) => withCaller(resolver, surface, options);"]
    : identity === "custom"
      ? ["  const guard = (surface: Surface) => withCaller(resolveCaller, surface);"]
      : ["  // no identity: every caller is anonymous", "  const guard = (surface: Surface) => (request: Request) => surface(request, { kind: \"anonymous\" });"];
  const meta = mantle && mcp ? ["  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource/mcp`;"] : [];
  const adminOptions = [
    'basePath: "/admin"',
    bun ? "assets: env.ASSETS" : "assets: (path) => adminAsset(env.ASSETS, path)",
    ...(mantle ? ["identity: { directory: auth, roles: auth, deleteUser: auth.deleteUser }"] : []),
    ...(mcp ? [`site: { mcpEndpoints: { public: "/mcp", staff: ${staffMcp ? '"/mcp/staff"' : "null"} } }`] : []),
  ];
  const surfaces = [
    ...(admin ? [`  ${identity === "custom" ? "// no AdminIdentity: Admin hides the user facets until src/identity.ts can list and manage users\n  " : ""}const admin = guard(createAdminSurface(runtime, { ${adminOptions.join(", ")} }));`] : []),
    ...(mcp ? [`  const mcp = guard(createMcpSurface(runtime, { basePath: "/mcp", surface: "public"${meta.length ? ", resourceMetadata" : ""} })${meta.length ? ", { resourceMetadata }" : ""});`] : []),
    // the staff tools for an MCP client with a token: the same audience as /mcp, and the staff surface's own role gate
    ...(staffMcp ? ["  // MCP Apps hosts render each staff View's rows, and the operations on one row, in the chat",
      `  const staffMcp = guard(createMcpSurface(runtime, { basePath: "/mcp/staff", surface: "staff", apps: { resources: [planApp(runtime.plan, { surface: "staff", html: mantleAppHtml })] }${meta.length ? ", resourceMetadata" : ""} })${meta.length ? ", { resourceMetadata }" : ""});`] : []),
    "  // REST answers everything else: public Views under /api/views and the plan's HTTP Triggers",
    '  const rest = guard(createRestSurface(runtime, { basePath: "/api" }));',
  ];
  const route = [
    `  return async (request: Request${mantle ? ", waitUntil: (promise: Promise<unknown>) => void" : ""}): Promise<Response> => {`,
    "    const { pathname } = new URL(request.url);",
    "    const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);",
    ...(mantle ? ["    // Better Auth's context is per isolate: the request that starts it waits for it, or the next one hangs on it; a failed start is mounted again",
      "    await auth.ready?.catch((error) => {",
      "      routes = undefined;",
      "      throw error;",
      "    });", "    const owned = await authRoutes(request, { waitUntil });", "    if (owned) return owned;"] : []),
    ...(admin ? ['    if (under("/admin")) return admin(request);'] : []),
    ...(staffMcp ? ['    if (under("/mcp/staff")) return staffMcp(request);'] : []),
    ...(mcp ? ['    if (under("/mcp")) return mcp(request);'] : []),
    "    return rest(request);",
    "  };",
  ];
  return [
    `${OWNED} It composes the service (ADR-0032 decision 6).`,
    `import { ${core.join(", ")} } from "@aotter/mantle";`,
    ...(admin ? ['import { createAdminSurface } from "@aotter/mantle/admin";'] : []),
    ...(auth.length ? [`import { ${auth.join(", ")} } from "@aotter/mantle/auth";`] : []),
    ...(bun
      ? [postgres ? 'import type { SQL } from "bun";' : 'import type { Database } from "bun:sqlite";', `import { ${postgres ? 'bunPostgresStorage' : 'bunSqliteStorage'}${mantle ? (postgres ? ', bunDatabaseDriver, bunAuthDatabase' : ', bunSqliteDriver') : ''} } from "@aotter/mantle/bun";`]
      : postgres
      ? [`import { ${mantle ? "pgDatabaseDriver, pgPool, " : ""}postgresStorage, type PgClient, type PgConnect } from "@aotter/mantle/postgres";`, 'import pg from "pg";']
      : [`import { ${mantle ? "d1Driver, " : ""}d1Storage } from "@aotter/mantle/cloudflare";`]),
    ...(mcp ? [`import { createMcpSurface${staffMcp ? ", planApp" : ""} } from "@aotter/mantle/mcp";`] : []),
    ...(staffMcp ? ['import { mantleAppHtml } from "@aotter/mantle-ui/mcp-app";'] : []),
    'import { createRestSurface } from "@aotter/mantle/web";',
    `import { plan } from "${MODULE}";`,
    'import { handlers } from "./handlers.js";',
    ...(identity === "custom" ? ['import { resolveCaller } from "./identity.js";'] : []),
    "",
    "export interface Env {",
    ...env,
    "}",
    "",
    ...(postgres && !bun ? [
      "/** A client per operation: Hyperdrive keeps the pool, and a Worker's socket must not outlive its request. */",
      'const connectTo = (env: Pick<Env, "HYPERDRIVE">): PgConnect => async () => {',
      "  const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });",
      "  await client.connect();",
      "  return client as unknown as PgClient;",
      "};",
      "",
    ] : []),
    ...(mantle ? [
      "/** One-time codes printed to the log are for local development: a deployed service picks its own sign-in method and sender. */",
      "function createAuth(env: Env, origin: string): MantleAuth {",
      "  // an unset PUBLIC_ORIGIN is not local: the fallback origin below is only for URLs, never for deciding to print codes",
      "  const local = env.PUBLIC_ORIGIN !== undefined && /^http:\\/\\/(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?$/.test(origin);",
      "  if (!local || !env.BETTER_AUTH_SECRET || !env.ADMIN_EMAIL)",
      `    return createSetupIncompleteAuth({ message: "Sign-in is not configured: copy ${localEnv}.example to ${localEnv} locally, or choose a sign-in method in src/service.ts." });`,
      "  return createMantleAuth({",
      bun
        ? postgres ? '    database: bunAuthDatabase(env.SQL), driver: bunDatabaseDriver(env.SQL), baseURL: origin, secret: env.BETTER_AUTH_SECRET,' : "    database: env.DB, driver: bunSqliteDriver(env.DB), baseURL: origin, secret: env.BETTER_AUTH_SECRET,"
        : postgres
        ? "    database: pgPool(connectTo(env)), driver: pgDatabaseDriver(connectTo(env)), baseURL: origin, secret: env.BETTER_AUTH_SECRET,"
        : "    database: env.DB, driver: d1Driver(env.DB), baseURL: origin, secret: env.BETTER_AUTH_SECRET,",
      '    methods: [{ kind: "email-otp", sender: new ConsoleEmailSender() }],',
      '    bootstrapOwner: { match: "email", value: env.ADMIN_EMAIL },',
      bun ? '    ipAddressHeaders: ["x-mantle-client-ip"],' : '    ipAddressHeaders: ["cf-connecting-ip"],',
      ...(mcp ? ['    oauthProvider: { loginPage: "/admin/sign-in", consentPage: "/oauth/consent", scopes: ["mcp"], mcpResource: `${origin}/mcp` },'] : []),
      "  });",
      "}",
      "",
    ] : []),
    ...(admin && !bun ? [
      "/** A file of the Admin SPA, or null when it has none by that path. */",
      "async function adminAsset(assets: Fetcher, path: string): Promise<Response | null> {",
      '  const response = await assets.fetch(new URL(path, "http://assets/"));',
      "  return response.ok ? response : null;",
      "}",
      "",
    ] : []),
    `function mount(runtime: MantleRuntime${withEnv ? ", env: Env" : ""}) {`,
    ...origin, ...caller, ...meta, ...surfaces, ...route,
    "}",
    "",
    "let routes: ReturnType<typeof mount> | undefined;",
    "const service: MantleService<Env> = {",
    "  handlers,",
    mantle
      ? "  fetch: (request, env, { runtime, waitUntil }) => (routes ??= mount(runtime, env))(request, waitUntil),"
      : withEnv
        ? "  fetch: (request, env, { runtime }) => (routes ??= mount(runtime, env))(request),"
        : "  fetch: (request, _env, { runtime }) => (routes ??= mount(runtime))(request),",
    "};",
    "",
    `export const mantle = createMantle(service, { plan, storage: (env) => ${bun ? (postgres ? "bunPostgresStorage(env.SQL)" : "bunSqliteStorage(env.DB)") : postgres ? "postgresStorage({ connect: connectTo(env) })" : "d1Storage(env.DB)"}, schedules: ${bun ? "false" : "true"} });`,
    "",
  ].join("\n");
}

function handlers(plan: RuntimePlan): string {
  const refs = [...new Set(Object.values(plan.procedures).flatMap((p) => ("ref" in p.handler ? [p.handler.ref] : [])))].sort();
  return [
    `${OWNED} \`MantleHandlers\` lists exactly the plan's handler refs.`,
    `import type { MantleHandlers } from "${MODULE}";`,
    "",
    `export const handlers: MantleHandlers = {${refs.length ? "" : "};"}`,
    ...(refs.length ? [...refs.map((r) => `  ${key(r)}: async () => {\n    throw new Error(${JSON.stringify(`not implemented: ${r}`)});\n  },`), "};"] : []),
    "",
  ].join("\n");
}

const IDENTITY = `${OWNED}
import type { CallerResolver } from "@aotter/mantle";

/**
 * Your service's users as Mantle callers (ADR-0032 decision 8). Read your session or token and return
 * \`{ caller: { kind: "user", subject, role, scopes, credential, credentialId, clientId } }\`; \`{ caller: { kind: "anonymous" } }\`
 * only when no credential was presented; \`{ invalid: true }\` when one was presented and failed.
 */
export const resolveCaller: CallerResolver = async () => {
  // TODO(mantle): until this is implemented every request fails, and never runs as anonymous.
  throw new Error("src/identity.ts: resolveCaller is not implemented. Map your session or token to a Caller.");
};
`;

const ENTRY = `${OWNED} The Cloudflare entry (ADR-0032 decision 6).
import { waitUntil } from "cloudflare:workers";
import { toCloudflareCron } from "@aotter/mantle/cloudflare";
import { plan } from "${MODULE}";
import { mantle, type Env } from "./service.js";

// Cloudflare names a cron as wrangler.jsonc spells it; the plan's schedule Triggers are POSIX, and several spellings can share one
const crons = new Map<string, string[]>();
for (const t of Object.values(plan.triggers)) {
  if (t.source.kind !== "schedule" || t.source.enabled === false) continue;
  const cf = toCloudflareCron(t.source.cron);
  const posix = crons.get(cf) ?? [];
  if (!posix.includes(t.source.cron)) crons.set(cf, [...posix, t.source.cron]);
}
// not bound to one request, so a handler's ctx.waitUntil never lands on another request's finished context
const ctx = { waitUntil };

export default {
  fetch: (request, env) => mantle.fetch(request, env, ctx),
  async scheduled(controller, env) {
    const posix = crons.get(controller.cron);
    if (posix === undefined) throw new Error(\`No schedule Trigger runs on the Cloudflare cron '\${controller.cron}'\`);
    const errors: unknown[] = [];
    for (const cron of posix) {
      try {
        await mantle.invokeSchedule(cron, controller.scheduledTime, env, ctx);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, \`\${errors.length} cron spelling(s) failed for '\${controller.cron}'\`);
  },
} satisfies ExportedHandler<Env>;
`;

/** Where the Admin SPA's files are once `@aotter/mantle-ui` is installed. */
const ADMIN_FILES = "node_modules/@aotter/mantle-ui/dist/admin";

/** Where `wrangler dev` finds PostgreSQL; the deployed Worker uses the Hyperdrive config instead. */
const LOCAL_PG = (name: string) => `postgres://postgres:postgres@127.0.0.1:5432/${name.replace(/-/g, "_")}`;

function wrangler(root: string, plan: RuntimePlan, admin: boolean, dialect: PresetSelection["dialect"]): string {
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "") || "mantle-app";
  const crons = [...new Set(Object.values(plan.triggers).flatMap((t) => (t.source.kind === "schedule" && t.source.enabled !== false ? [toCloudflareCron(t.source.cron)] : [])))].sort();
  return json({
    $schema: "node_modules/wrangler/config-schema.json", name, main: "src/index.ts", compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"],
    ...(dialect === "postgres"
      // `wrangler hyperdrive create <name> --caching-disabled --connection-string=...` prints the id: Mantle reads in transactions,
      // which Hyperdrive never caches, but Better Auth's session reads are not, so caching stays off
      ? { hyperdrive: [{ binding: "HYPERDRIVE", id: "REPLACE_WITH_HYPERDRIVE_CONFIG_ID", localConnectionString: LOCAL_PG(name) }] }
      : { d1_databases: [{ binding: "DB", database_name: name }] }),
    // the Worker answers every request (Admin serves the shell with its own headers); `none` keeps index.html fetchable by name
    ...(admin ? { assets: { directory: ADMIN_FILES, binding: "ASSETS", run_worker_first: true, html_handling: "none" } } : {}),
    ...(crons.length ? { triggers: { crons } } : {}),
  });
}

const TSCONFIG = json({
  compilerOptions: {
    target: "ES2022", lib: ["ES2023"], module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, skipLibCheck: true, resolveJsonModule: true,
    // node: `nodejs_compat` serves the node: modules @aotter/mantle/auth imports
    types: ["@cloudflare/workers-types", "node"],
  },
  include: ["src/**/*.ts", ".mantle/generated/**/*.ts"],
});

const DEV_VARS = `# Copy to .dev.vars for local sign-in: one-time codes are printed to the wrangler log. Never deploy these values.
PUBLIC_ORIGIN=http://127.0.0.1:8787
ADMIN_EMAIL=you@example.com
BETTER_AUTH_SECRET=replace-with-a-random-32-byte-secret
`;

/** The preset's files for this selection, by path. */
export function presetFiles(root: string, selection: PresetSelection, plan: RuntimePlan): [string, string][] {
  return [
    ["src/handlers.ts", handlers(plan)],
    ...(selection.identity === "custom" ? [["src/identity.ts", IDENTITY] as [string, string]] : []),
    ["src/index.ts", selection.host === "bun" ? bunEntry(selection) : ENTRY],
    ...(selection.host === "bun" ? [] : ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].some((f) => existsSync(join(root, f))) ? [] : [["wrangler.jsonc", wrangler(root, plan, selection.features.includes("admin"), selection.dialect)] as [string, string]]),
    ["tsconfig.json", selection.host === "bun" ? TSCONFIG.replace('"@cloudflare/workers-types",', '"bun-types",').replace('"ES2023"', '"ES2023",\n      "DOM"') : TSCONFIG],
    ...(selection.identity === "mantle" || selection.host === "bun" ? [[selection.host === "bun" ? ".env.example" : ".dev.vars.example", selection.host === "bun" ? bunEnv(selection) : DEV_VARS] as [string, string]] : []),
    [".gitignore", "node_modules/\n.wrangler/\n.dev.vars\n.env\n*.sqlite\n*.sqlite-shm\n*.sqlite-wal\n"],
    // last: its existence is what marks the preset as written, so a write that failed midway is completed by the rerun
    ["src/service.ts", service(selection)],
  ];
}

/**
 * Writes each preset file that does not exist, and none when `src/service.ts` does: the application then owns its composition.
 * Returns the paths written.
 */
export async function writePreset(root: string, selection: PresetSelection, plan: RuntimePlan): Promise<string[]> {
  if (existsSync(join(root, "src/service.ts"))) return [];
  const written: string[] = [];
  for (const [path, text] of presetFiles(root, selection, plan)) {
    try {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text, { flag: "wx" });
      written.push(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw new Error(`cannot write ${path} (${code ?? "error"})`);
    }
  }
  return written;
}

/** What the application-owned files may have drifted from: never written, only reported. */
export async function presetWarnings(root: string, selection: PresetSelection, selectionChanged: boolean, plan: RuntimePlan): Promise<string[]> {
  if (!existsSync(join(root, "src/service.ts"))) return [];
  const out: string[] = [];
  if (selectionChanged) out.push(`the selection changed but src/service.ts already exists and is yours: update its composition to identity '${selection.identity}' and features ${selection.features.join(", ") || "none"}`);
  if (selection.host === "bun") return out;
  const wrangler = await readFile(join(root, "wrangler.jsonc"), "utf8").catch(() => undefined);
  if (wrangler !== undefined) {
    const declared = new Set([...(/"crons"\s*:\s*\[([^\]]*)\]/.exec(wrangler)?.[1] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]!));
    const wanted = new Set(Object.values(plan.triggers).flatMap((t) => (t.source.kind === "schedule" && t.source.enabled !== false ? [toCloudflareCron(t.source.cron)] : [])));
    const missing = [...wanted].filter((c) => !declared.has(c));
    const extra = [...declared].filter((c) => !wanted.has(c));
    if (selection.dialect === "postgres" && !/"hyperdrive"\s*:/.test(wrangler)) out.push('wrangler.jsonc has no hyperdrive binding, which src/service.ts reads PostgreSQL through: add "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<config id>", "localConnectionString": "postgres://..." }]');
    if (selection.dialect === "postgres" && wrangler.includes("REPLACE_WITH_HYPERDRIVE_CONFIG_ID")) out.push("wrangler.jsonc's Hyperdrive id is still the placeholder: create the config with `wrangler hyperdrive create <name> --caching-disabled --connection-string=...` before deploying");
    if (selection.features.includes("admin") && !/"binding"\s*:\s*"ASSETS"/.test(wrangler)) out.push('wrangler.jsonc binds no ASSETS, which src/service.ts serves the Admin console from: add "assets": { "directory": "node_modules/@aotter/mantle-ui/dist/admin", "binding": "ASSETS", "run_worker_first": true, "html_handling": "none" }');
    if (missing.length || extra.length) out.push(`wrangler.jsonc triggers.crons does not match the plan's schedule Triggers${missing.length ? `; add ${missing.map((c) => `"${c}"`).join(", ")}` : ""}${extra.length ? `; nothing runs on ${extra.map((c) => `"${c}"`).join(", ")}` : ""}`);
  }
  return out;
}

function bunEntry(selection: PresetSelection): string {
  const pg = selection.dialect === 'postgres';
  const admin = selection.features.includes('admin');
  return `${OWNED} Bun owns the server, native database pool and background work.
${pg ? 'import { SQL } from "bun";' : 'import { Database } from "bun:sqlite";'}
${admin ? 'import { bunAdminAssets } from "@aotter/mantle/bun";\nimport { dirname } from "node:path";\nimport { fileURLToPath } from "node:url";\n' : ''}import { mantle, type Env } from "./service.js";

${pg ? 'if (!process.env.DATABASE_URL || !/^postgres(?:ql)?:\\/\\//.test(process.env.DATABASE_URL)) throw new Error("DATABASE_URL must be a PostgreSQL URL");\nconst sql = new SQL(process.env.DATABASE_URL, { bigint: true, prepare: false });' : 'const db = new Database(process.env.DATABASE_FILE ?? "mantle.sqlite", { create: true });'}
const env: Env = {
  ${pg ? 'SQL: sql' : 'DB: db'},
${admin ? '  ASSETS: bunAdminAssets(dirname(fileURLToPath(import.meta.resolve("@aotter/mantle-ui/admin/index.html")))),\n' : ''}${selection.identity === 'mantle' ? '  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET, ADMIN_EMAIL: process.env.ADMIN_EMAIL,\n' : ''}};
// the client is the socket's address; behind a proxy you list in TRUSTED_PROXIES, the address it appended to X-Forwarded-For
const proxies = new Set((process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const pending = new Set<Promise<unknown>>();
const waitUntil = (promise: Promise<unknown>) => {
  const task = promise.catch(console.error).finally(() => pending.delete(task));
  pending.add(task);
};
const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000),
  // never Bun's development error page: it shows the exception, the stack and paths to any client
  development: false,
  error(error) {
    console.error(error);
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "Internal error" } }, { status: 500 });
  },
  fetch(request, server) {
    const headers = new Headers(request.headers);
    headers.delete("x-mantle-client-ip");
    const socket = server.requestIP(request)?.address;
    const forwarded = socket && proxies.has(socket) ? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() : undefined;
    const ip = forwarded || socket;
    if (ip) headers.set("x-mantle-client-ip", ip);
    return mantle.fetch(new Request(request, { headers }), env, { waitUntil });
  },
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop();
  while (pending.size) await Promise.allSettled([...pending]);
  ${pg ? 'await sql.close();' : 'db.close();'}
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
console.log(\`Mantle: \${server.url}\`);
`;
}

function bunEnv(selection: PresetSelection): string {
  return `# Copy to .env for local development. Never deploy these values.
${selection.dialect === 'postgres' ? 'DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mantle_app' : 'DATABASE_FILE=mantle.sqlite'}
PORT=3000
# Behind a reverse proxy, list its addresses so each client keeps its own sign-in rate limit, e.g. TRUSTED_PROXIES=127.0.0.1
# TRUSTED_PROXIES=
${selection.identity === 'mantle' ? 'PUBLIC_ORIGIN=http://127.0.0.1:3000\nADMIN_EMAIL=you@example.com\nBETTER_AUTH_SECRET=replace-with-a-random-32-byte-secret\n' : ''}`;
}
