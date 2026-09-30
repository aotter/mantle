/**
 * The Cloudflare service preset (ADR-0032 decision 6 and amendment "the service preset"): application-owned files `mantle generate`
 * writes once and never again. Nothing here is compared by `--check`.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RuntimePlan } from "../spec/index.js";
import { toCloudflareCron } from "../spec/domain/service/CloudflareCron.js";

export interface PresetSelection {
  readonly identity: "mantle" | "custom" | "none";
  readonly features: readonly string[];
}

/** The generated module, as `src/*.ts` imports it (a constant, so check:boundaries does not read it as this folder's import). */
const MODULE = "../.mantle/generated/mantle.js";
const OWNED = "// Written once by `mantle generate`; this file is yours now.";
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const key = (s: string) => (/^[A-Za-z_$][\w$]*$/.test(s) ? s : JSON.stringify(s));

function service({ identity, features }: PresetSelection): string {
  const mcp = features.includes("mcp");
  const admin = features.includes("admin");
  const mantle = identity === "mantle";
  const core = ["createMantle", ...(identity === "none" ? [] : ["withCaller"]), "type MantleRuntime", "type MantleService", "type Surface"];
  const auth = mantle ? ["ConsoleEmailSender", "createAuthRoutes", "createCallerResolver", "createMantleAuth", "createSetupIncompleteAuth", "type MantleAuth"] : [];
  const env = ["  readonly DB: D1Database;", ...(mantle ? ["  readonly BETTER_AUTH_SECRET?: string;", "  readonly PUBLIC_ORIGIN?: string;", "  readonly ADMIN_EMAIL?: string;"] : [])];
  const origin = mantle ? ["  const origin = env.PUBLIC_ORIGIN?.replace(/\\/+$/, \"\") ?? \"http://127.0.0.1:8787\";", "  const auth = createAuth(env, origin);"] : [];
  const caller = mantle
    ? [`  const resolver = createCallerResolver(auth${mcp ? ", { jwtBearer: { audience: `${origin}/mcp` } }" : ""});`, "  const authRoutes = createAuthRoutes(auth, { resolver });", "  const guard = (surface: Surface, options?: { resourceMetadata?: string }) => withCaller(resolver, surface, options);"]
    : identity === "custom"
      ? ["  const guard = (surface: Surface) => withCaller(resolveCaller, surface);"]
      : ["  // no identity: every caller is anonymous", "  const guard = (surface: Surface) => (request: Request) => surface(request, { kind: \"anonymous\" });"];
  const meta = mantle && mcp ? ["  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource/mcp`;"] : [];
  const adminOptions = [
    'basePath: "/admin"',
    ...(mantle ? ["identity: { directory: auth, roles: auth, deleteUser: auth.deleteUser }"] : []),
    ...(mcp ? ['staffMcp: createMcpSurface(runtime, { basePath: "/admin/api/mcp", surface: "staff" })', 'site: { mcpEndpoints: { public: "/mcp", staff: null } }'] : []),
  ];
  const surfaces = [
    ...(admin ? [`  ${identity === "custom" ? "// no AdminIdentity: Admin hides the user facets until src/identity.ts can list and manage users\n  " : ""}const admin = guard(createAdminSurface(runtime, { ${adminOptions.join(", ")} }));`] : []),
    ...(mcp ? [`  const mcp = guard(createMcpSurface(runtime, { basePath: "/mcp", surface: "public"${meta.length ? ", resourceMetadata" : ""} })${meta.length ? ", { resourceMetadata }" : ""});`] : []),
    "  // REST answers everything else: public Views under /api/views and the plan's HTTP Triggers",
    '  const rest = guard(createRestSurface(runtime, { basePath: "/api" }));',
  ];
  const route = [
    `  return async (request: Request${mantle ? ", waitUntil: (promise: Promise<unknown>) => void" : ""}): Promise<Response> => {`,
    "    const { pathname } = new URL(request.url);",
    "    const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);",
    ...(mantle ? ["    await auth.ready; // Better Auth's context is per isolate: the request that starts it waits for it, or the next one hangs on it", "    const owned = await authRoutes(request, { waitUntil });", "    if (owned) return owned;"] : []),
    ...(admin ? ['    if (under("/admin")) return admin(request);'] : []),
    ...(mcp ? ['    if (under("/mcp")) return mcp(request);'] : []),
    "    return rest(request);",
    "  };",
  ];
  return [
    `${OWNED} It composes the service (ADR-0032 decision 6).`,
    `import { ${core.join(", ")} } from "@aotter/mantle";`,
    ...(admin ? ['import { createAdminSurface } from "@aotter/mantle/admin";'] : []),
    ...(auth.length ? [`import { ${auth.join(", ")} } from "@aotter/mantle/auth";`] : []),
    `import { ${mantle ? "d1Driver, " : ""}d1Storage } from "@aotter/mantle/cloudflare";`,
    ...(mcp ? ['import { createMcpSurface } from "@aotter/mantle/mcp";'] : []),
    'import { createRestSurface } from "@aotter/mantle/web";',
    `import { plan } from "${MODULE}";`,
    'import { handlers } from "./handlers.js";',
    ...(identity === "custom" ? ['import { resolveCaller } from "./identity.js";'] : []),
    "",
    "export interface Env {",
    ...env,
    "}",
    "",
    ...(mantle ? [
      "/** One-time codes printed to the log are for local development: a deployed service picks its own sign-in method and sender. */",
      "function createAuth(env: Env, origin: string): MantleAuth {",
      "  const local = /^http:\\/\\/(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?$/.test(origin);",
      "  if (!local || !env.BETTER_AUTH_SECRET || !env.ADMIN_EMAIL)",
      '    return createSetupIncompleteAuth({ message: "Sign-in is not configured: copy .dev.vars.example to .dev.vars locally, or choose a sign-in method in src/service.ts." });',
      "  return createMantleAuth({",
      "    database: env.DB, driver: d1Driver(env.DB), baseURL: origin, secret: env.BETTER_AUTH_SECRET,",
      '    methods: [{ kind: "email-otp", sender: new ConsoleEmailSender() }],',
      '    bootstrapOwner: { match: "email", value: env.ADMIN_EMAIL },',
      '    ipAddressHeaders: ["cf-connecting-ip"],',
      ...(mcp ? ['    oauthProvider: { loginPage: "/admin/sign-in", consentPage: "/oauth/consent", scopes: ["mcp"], mcpResource: `${origin}/mcp` },'] : []),
      "  });",
      "}",
      "",
    ] : []),
    `function mount(runtime: MantleRuntime${mantle ? ", env: Env" : ""}) {`,
    ...origin, ...caller, ...meta, ...surfaces, ...route,
    "}",
    "",
    "let routes: ReturnType<typeof mount> | undefined;",
    "const service: MantleService<Env> = {",
    "  handlers,",
    mantle
      ? "  fetch: (request, env, { runtime, waitUntil }) => (routes ??= mount(runtime, env))(request, waitUntil),"
      : "  fetch: (request, _env, { runtime }) => (routes ??= mount(runtime))(request),",
    "};",
    "",
    "export const mantle = createMantle(service, { plan, storage: (env) => d1Storage(env.DB), schedules: true });",
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

// Cloudflare names a cron as wrangler.jsonc spells it; the plan's schedule Triggers are POSIX
const crons = new Map(Object.values(plan.triggers).flatMap((t) => (t.source.kind === "schedule" && t.source.enabled !== false ? [[toCloudflareCron(t.source.cron), t.source.cron] as const] : [])));
// not bound to one request, so a handler's ctx.waitUntil never lands on another request's finished context
const ctx = { waitUntil };

export default {
  fetch: (request, env) => mantle.fetch(request, env, ctx),
  scheduled(controller, env) {
    const cron = crons.get(controller.cron);
    if (cron === undefined) throw new Error(\`No schedule Trigger runs on the Cloudflare cron '\${controller.cron}'\`);
    return mantle.invokeSchedule(cron, controller.scheduledTime, env, ctx);
  },
} satisfies ExportedHandler<Env>;
`;

function wrangler(root: string, plan: RuntimePlan): string {
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "") || "mantle-app";
  const crons = [...new Set(Object.values(plan.triggers).flatMap((t) => (t.source.kind === "schedule" && t.source.enabled !== false ? [toCloudflareCron(t.source.cron)] : [])))].sort();
  return json({
    $schema: "node_modules/wrangler/config-schema.json", name, main: "src/index.ts", compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"],
    d1_databases: [{ binding: "DB", database_name: name }],
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
    ["src/service.ts", service(selection)],
    ["src/handlers.ts", handlers(plan)],
    ...(selection.identity === "custom" ? [["src/identity.ts", IDENTITY] as [string, string]] : []),
    ["src/index.ts", ENTRY],
    ...(["wrangler.jsonc", "wrangler.json", "wrangler.toml"].some((f) => existsSync(join(root, f))) ? [] : [["wrangler.jsonc", wrangler(root, plan)] as [string, string]]),
    ["tsconfig.json", TSCONFIG],
    ...(selection.identity === "mantle" ? [[".dev.vars.example", DEV_VARS] as [string, string]] : []),
    [".gitignore", "node_modules/\n.wrangler/\n.dev.vars\n"],
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
    await mkdir(dirname(join(root, path)), { recursive: true });
    try {
      await writeFile(join(root, path), text, { flag: "wx" });
      written.push(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return written;
}
