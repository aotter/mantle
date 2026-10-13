/** Native integration fixture: no mock API, private data or production auth bypass. */
import { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const sdk = process.env.MANTLE_NEXT_ROOT;
const require = createRequire(join(sdk, "package.json"));
const { betterAuth } = await import(require.resolve("better-auth/minimal"));
const { admin: adminPlugin, emailOTP } = await import(require.resolve("better-auth/plugins"));
const { createAccessControl } = await import(require.resolve("better-auth/plugins/access"));
const { defaultStatements } = await import(require.resolve("better-auth/plugins/admin/access"));
const { d1Adapter } = await import(join(sdk, "src/auth/adapter.ts"));
const { authLoader, resolveCaller } = await import(join(sdk, "src/auth/caller.ts"));
const { authRoutes } = await import(join(sdk, "src/auth/routes.ts"));
const { d1Identity } = await import(join(sdk, "src/auth/identity.ts"));
const { generateFromSources } = await import(join(sdk, "src/infrastructure/generateAuth.ts"));
const { writeGenerated } = await import(join(sdk, "tests/apps/link.ts"));
const { d1Shim } = await import(join(sdk, "tests/apps/d1-shim.ts"));
const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: tasks}
spec:
 title: Tasks
 lifecycle: operational
 uiSchema: {list: {primaryField: title, columns: []}}
 uniqueIndexes: [[title]]
 searchableFields: [title]
 schema: {type: object, required: [title], properties: {title: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: articles}
spec:
 title: Articles
 lifecycle: publishing
 schema: {type: object, required: [title], properties: {title: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: add-task}
spec:
 requires: {auth: {all: [{ctx.staff: [staff]}]}}
 input: {type: object, required: [title], properties: {title: {type: string}, id: {type: string}, expectedVersion: {type: integer}}, additionalProperties: false}
 output: {type: object}
 handler: {sql: 'INSERT INTO tasks (title) VALUES (input.title) RETURNING id'}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: expose-add}
spec:
 source: {kind: mcp, surface: staff}
 target: {procedure: add-task}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: uncertain-task}
spec:
 requires: {auth: {all: [{ctx.staff: [staff]}]}}
 input: {type: object, required: [title], properties: {title: {type: string}}, additionalProperties: false}
 output: {type: object}
 handler: {ref: app.uncertain}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: expose-uncertain}
spec:
 source: {kind: mcp, surface: staff}
 target: {procedure: uncertain-task}
`;
const dir = await mkdtemp(join(tmpdir(), "mantle-next-ui-"));
const db = new Database(":memory:");
let handler;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handler(request) });
try {
  const ac = createAccessControl(defaultStatements);
  const options = {
    baseURL: server.url.origin, basePath: "/api/auth", secret: "native-console-fixture-secret-01234567890123456789",
    database: d1Adapter(d1Shim(db)),
    user: { additionalFields: { githubLogin: { type: "string", required: false } } },
    plugins: [
      adminPlugin({ adminRoles: ["staff"], ac, roles: { staff: ac.newRole(defaultStatements), user: ac.newRole({ user: [], session: [] }) } }),
      emailOTP({ sendVerificationOTP: async ({ email, otp }) => { console.log(JSON.stringify({ email, otp })); } }),
    ],
  };
  const generated = await generateFromSources({ target: "bun-sqlite", sources: { sources: [{ sourceId: "console.yaml", text: source }] }, auth: options, admin: true });
  if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
  const files = generated.files;
  await writeGenerated(dir, files, false);
  // Source-selected fixture only; packed consumer acceptance is a separate check.
  await mkdir(join(dir, "node_modules/@aotter"), { recursive: true });
  await symlink(resolve(import.meta.dirname, "../.."), join(dir, "node_modules/@aotter/mantle-admin"));
  await symlink(sdk, join(dir, "node_modules/@aotter/mantle"));
  db.exec(files["schema.sql"]);
  const auth = betterAuth(options), context = await auth.$context;
  for (const role of ["staff", "user"])
    await context.internalAdapter.createUser({ id: role, email: role + "@example.test", name: role, role, emailVerified: true }, { method: "admin" });
  const { store } = await import(join(dir, "generated.ts"));
  const system = { kind: "system", reason: "generic fixture seed" };
  const tasks = store(db, system).collection("tasks");
  for (let i = 0; i < 105; i++) await tasks.insert({ title: "Task " + String(i).padStart(3, "0") });
  await store(db, system).collection("articles").insert({ title: "Draft article" });
  const loader = authLoader(async () => auth);
  const caller = (request) => resolveCaller(request, loader);
  const signIn = authRoutes(loader, { methods: [{ kind: "email-otp" }], resolver: caller });
  const { adminBindings } = await import(join(dir, "admin-bindings.ts"));
  const { admin } = await import(resolve(import.meta.dirname, "../../src/server/index.ts"));
  const { entries } = await import(resolve(import.meta.dirname, "../../src/server/entries.ts"));
  const { siteRoutes } = await import(resolve(import.meta.dirname, "../../src/server/site.ts"));
  const { ContractError } = await import(join(sdk, "dist/kernel/contracts.js"));
  const assets = resolve(import.meta.dirname, "../../dist/admin");
  const indexHtml = await Bun.file(join(assets, "index.html")).text();
  const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(indexHtml)?.[1];
  if (!importMap) throw new Error("Built Admin import map is missing.");
  const importMapHash = createHash("sha256").update(importMap).digest("base64");
  const handlers = { "uncertain-task": async (c, input) => {
    await c.store.collection("tasks").insert(input);
    throw new ContractError("OUTCOME_UNKNOWN", "Fixture failure after a committed native write.");
  } };
  const bindings = adminBindings({ handlers });
  const adminOptions = {
    db: () => db, caller, handlers,
    getUser: async (id) => context.adapter.findOne({ model: "user", where: [{ field: "id", value: id }] }),
    identity: { directory: (c) => d1Identity(d1Shim(db), auth, c.caller, c.request.headers) },
  };
  const consoleHandler = admin(bindings.metadata, bindings.views, bindings.operations, {
    ...adminOptions, routes: [...entries(bindings.schemas, bindings.adapter), ...siteRoutes(adminOptions)],
  });
  // Assets and the SPA shell belong to the application, never the native API router.
  const shell = async request => {
    const url = new URL(request.url);
    if (request.method !== "GET" || !(url.pathname === "/admin" || url.pathname.startsWith("/admin/"))) return;
    const path = decodeURIComponent(url.pathname.slice("/admin/".length));
    if (path.split("/").some(segment => segment === "." || segment === "..")) return new Response("not found", { status: 404 });
    const file = Bun.file(join(assets, path));
    if (path && await file.exists()) return new Response(file);
    if (path.startsWith("assets/") || path.startsWith("shared/") || path.includes(".")) return new Response("not found", { status: 404 });
    return new Response(indexHtml, { headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": `default-src 'self'; script-src 'self' 'sha256-${importMapHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`,
    } });
  };
  handler = async request => await signIn(request) ?? await consoleHandler(request, {}) ?? await shell(request) ?? new Response("not found", { status: 404 });
  console.log(JSON.stringify({ ready: server.url.origin }));
  const close = async () => { server.stop(true); db.close(); await rm(dir, { recursive: true, force: true }); process.exit(); };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
} catch (error) {
  server.stop(true); db.close(); await rm(dir, { recursive: true, force: true }); throw error;
}
