/** Native integration fixture: no mock API, private data or production auth bypass. */
import { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const sdk = process.env.MANTLE_NEXT_ROOT!;
const require = createRequire(join(sdk, "package.json"));
const { betterAuth } = await import(require.resolve("better-auth/minimal"));
const { admin: adminPlugin, emailOTP } = await import(require.resolve("better-auth/plugins"));
const { createAccessControl } = await import(require.resolve("better-auth/plugins/access"));
const { defaultStatements } = await import(require.resolve("better-auth/plugins/admin/access"));
const { d1Adapter } = await import(join(sdk, "src/auth/adapter.ts"));
const { authSchemaSql } = await import(join(sdk, "src/auth/schema.ts"));
const { authLoader, resolveCaller } = await import(join(sdk, "src/auth/caller.ts"));
const { authRoutes } = await import(join(sdk, "src/auth/routes.ts"));
const { d1Identity } = await import(join(sdk, "src/auth/identity.ts"));
const { generateOrThrow, writeGenerated } = await import(join(sdk, "tests/apps/link.ts"));
const { d1Shim } = await import(join(sdk, "tests/apps/d1-shim.ts"));
const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: tasks}
spec:
 title: Tasks
 lifecycle: operational
 uiSchema: {list: {primaryField: title, columns: [title]}}
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
`;
const dir = await mkdtemp(join(tmpdir(), "mantle-next-ui-"));
const db = new Database(":memory:");
let handler: (request: Request) => Promise<Response>;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handler(request) });
try {
  const ac = createAccessControl(defaultStatements);
  const options = {
    baseURL: server.url.origin, basePath: "/api/auth", secret: "native-console-fixture-secret-01234567890123456789",
    database: d1Adapter(d1Shim(db)),
    user: { additionalFields: { githubLogin: { type: "string", required: false } } },
    plugins: [
      adminPlugin({ adminRoles: ["staff"], ac, roles: { staff: ac.newRole(defaultStatements), user: ac.newRole({ user: [], session: [] }) } }),
      emailOTP({ sendVerificationOTP: async ({ email, otp }: { email: string; otp: string }) => { console.log(JSON.stringify({ email, otp })); } }),
    ],
  };
  for (const sql of authSchemaSql(options, "sqlite")) db.exec(sql);
  const auth = betterAuth(options), context = await auth.$context;
  for (const role of ["staff", "user"])
    await context.internalAdapter.createUser({ id: role, email: role + "@example.test", name: role, role, emailVerified: true }, { method: "admin" });
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "console.yaml", text: source }]);
  await writeGenerated(dir, files);
  db.exec(files["schema.sql"] + files["admin-schema.sql"]);
  const { store } = await import(join(dir, "generated.ts"));
  const system = { kind: "system", reason: "generic fixture seed" };
  const tasks = store(db, system).collection("tasks");
  for (let i = 0; i < 105; i++) await tasks.insert({ title: "Task " + String(i).padStart(3, "0") });
  await store(db, system).collection("articles").insert({ title: "Draft article" });
  const loader = authLoader(async () => auth);
  const caller = (request: Request) => resolveCaller(request, loader);
  const signIn = authRoutes(loader, { methods: [{ kind: "email-otp" }], resolver: caller });
  const { admin } = await import(join(dir, "admin.ts"));
  const assets = resolve(import.meta.dirname, "../../dist/admin");
  const consoleHandler = admin({
    db: () => db, caller,
    assets: async (path: string) => { const file = Bun.file(join(assets, path)); return await file.exists() ? new Response(file) : null; },
    getUser: async (id: string) => context.adapter.findOne({ model: "user", where: [{ field: "id", value: id }] }),
    identity: { directory: (c: any) => d1Identity(d1Shim(db), auth, c.caller, c.request.headers) },
  });
  handler = async request => await signIn(request) ?? await consoleHandler(request, {}) ?? new Response("not found", { status: 404 });
  console.log(JSON.stringify({ ready: server.url.origin }));
  const close = async () => { server.stop(true); db.close(); await rm(dir, { recursive: true, force: true }); process.exit(); };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
} catch (error) {
  server.stop(true); db.close(); await rm(dir, { recursive: true, force: true }); throw error;
}
