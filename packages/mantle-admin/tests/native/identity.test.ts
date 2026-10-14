import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import { authLoader, resolveCaller } from "@aotter/mantle/auth";
import { d1Adapter } from "@aotter/mantle/auth/adapter";
import { guardAuthAdminRequest } from "@aotter/mantle/auth/admin";
import { d1Identity } from "@aotter/mantle/auth/identity";
import { authSchemaSql } from "../../../mantle/src/infrastructure/authSchema.js";
import { d1Shim } from "../../../mantle/tests/apps/d1-shim.js";
import { admin as adminServer } from "../../src/server/index.js";
import { siteRoutes } from "../../src/server/site.js";

// Better Auth is an optional SDK dependency, installed by the SDK's native test fixture.
const requireAuth = createRequire(new URL("../../../mantle/package.json", import.meta.url));
const { betterAuth } = await import(requireAuth.resolve("better-auth/minimal"));
const { admin, emailOTP } = await import(requireAuth.resolve("better-auth/plugins"));
const { createAccessControl } = await import(requireAuth.resolve("better-auth/plugins/access"));
const { defaultStatements } = await import(requireAuth.resolve("better-auth/plugins/admin/access"));

test("Admin identity routes use Better Auth statements for listing, fields, roles, creation and deletion", async () => {
  const db = new Database(":memory:"), d1 = d1Shim(db), ac = createAccessControl(defaultStatements);
  let otp = "";
  const options = {
    secret: "admin-ac-test-secret-01234567890123456789", baseURL: "https://app.test",
    database: d1Adapter(d1), user: { additionalFields: { region: { type: "string" as const, input: false, required: false } } },
    plugins: [admin({ adminRoles: ["admin", "denied"], ac, roles: {
      admin: ac.newRole(defaultStatements), user: ac.newRole({ user: [], session: [] }),
      support: ac.newRole({ user: ["list"], session: [] }), denied: ac.newRole({ user: [], session: [] }),
    } }), emailOTP({ sendVerificationOTP: async (input: { otp: string }) => { otp = input.otp; } })],
  };
  try {
    db.exec(authSchemaSql(options, "sqlite").join(";"));
    const auth = betterAuth(options), ctx = await auth.$context;
    for (const [id, role] of [["actor", "admin"], ["spare", "admin"], ["member", "user"], ["invited", "admin"]])
      await ctx.internalAdapter.createUser({ id, email: `${id}@example.test`, name: id, emailVerified: id !== "invited", role, region: "TW" }, { method: "admin" });
    await auth.api.sendVerificationOTP({ body: { email: "actor@example.test", type: "sign-in" } });
    const signed = await auth.api.signInEmailOTP({ body: { email: "actor@example.test", otp }, returnHeaders: true });
    const headers = new Headers({ cookie: signed.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; "), origin: "https://app.test", "content-type": "application/json" });
    const identity = { directory: (c: any) => d1Identity(d1, auth, c.caller, c.request.headers) };
    const api = adminServer({ collections: [], views: [], operations: [], webmcp: {} }, [], [], {
      db: () => d1, caller: request => resolveCaller(request, authLoader(async () => auth)), identity,
      routes: siteRoutes({ db: () => d1, identity }),
    });
    const ask = async (path: string, method = "GET", input?: unknown) => {
      const request = new Request(`https://app.test${path.startsWith("/api/auth/") ? path : `/admin/api${path}`}`, { method, headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (path.startsWith("/api/auth/")) {
        await guardAuthAdminRequest(request, () => resolveCaller(request, authLoader(async () => auth)));
        return auth.handler(request);
      }
      return (await api(request, {}))!;
    };
    await ctx.internalAdapter.updateUser("actor", { role: "support" });
    expect((await ask("/me")).status).toBe(200);
    expect((await ask("/members")).status).toBe(200);
    expect((await ask("/admin")).status).toBe(200);
    for (const [path, method, input] of [
      ["/api/auth/admin/update-user", "POST", { userId: "member", data: { region: "US" } }],
      ["/api/auth/admin/update-user", "POST", { userId: "member", data: { role: ["admin"] } }],
      ["/admin/member/role", "PATCH", { role: "admin" }],
      ["/admin/invitations", "POST", { email: "new@example.test", role: "admin" }],
      ["/admin/invitations/invited", "DELETE", undefined],
    ] as const) expect((await ask(path, method, input)).status).toBe(403);
    expect(await ctx.internalAdapter.findUserById("member")).toMatchObject({ role: "user", region: "TW" });
    await ctx.internalAdapter.updateUser("actor", { role: "denied" });
    expect((await ask("/members")).status).toBe(403);
    expect((await ask("/admin")).status).toBe(403);
    await ctx.internalAdapter.updateUser("actor", { role: "admin" });
    expect((await ask("/api/auth/admin/update-user", "POST", { userId: "member", data: { region: "US" } })).status).toBe(200);
    expect(await ctx.internalAdapter.findUserById("member")).toMatchObject({ region: "US" });
  } finally { db.close(); }
});
