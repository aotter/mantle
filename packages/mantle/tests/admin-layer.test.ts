import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { authLoader, resolveCaller, type AuthInstance } from "../src/auth/caller.js";
import { isAdmin, hasAdminRole, type Caller } from "../src/kernel/contracts.js";
import { mcp } from "../src/kernel/mcp.js";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";

const user = (role: string, admin = false): Caller => ({ kind: "user", subject: "reader", role, admin, scopes: ["mcp"], credential: "session", credentialId: "session", clientId: null });
const request = () => new Request("https://app.test/private", { headers: { cookie: "better-auth.session_token=fixture" } });
function auth(role: string, adminRoles?: readonly string[], plugin = true): AuthInstance {
  return { options: { plugins: plugin ? [{ id: "admin", options: adminRoles ? { adminRoles } : undefined } as never] : [] }, $context: Promise.resolve({}), api: { getSession: async () => ({ headers: null, response: { session: { id: "session" }, user: { id: "reader", role } } }) } };
}

test("Better Auth configuration classifies defaults, comma-separated custom roles, and no-admin deployments", async () => {
  for (const [role, roles, plugin, expected] of [
    ["admin,editor", undefined, true, true], ["editor", undefined, true, false],
    ["vip,editor", ["editor", "orgAdmin"], true, true], ["orgAdmin,vip", ["editor", "orgAdmin"], true, true],
    ["admin", ["editor"], true, false], ["editorial", ["editor"], true, false],
    ["admin", [], true, false], ["admin", undefined, false, false],
  ] as const) {
    const caller = await resolveCaller(request(), authLoader(async () => auth(role, roles, plugin)));
    expect(isAdmin(caller)).toBe(expected);
    expect(hasAdminRole(caller, "editor")).toBe(expected && role.split(",").includes("editor"));
  }
  expect(hasAdminRole(user("admin,editor"), "editor")).toBe(false);
  expect(hasAdminRole(user("vip,editor", true), "editor")).toBe(true);
});

test("service credentials use the same configured layer and scope checks", async () => {
  const supplied = { ...user("editor"), credential: "api-key" as const };
  const caller = await resolveCaller(request(), authLoader(async () => auth("", ["editor"])), { resolveCredential: () => supplied, scopes: ["mcp"] });
  expect(isAdmin(caller)).toBe(true);
  await expect(resolveCaller(request(), authLoader(async () => auth("", ["editor"])), { resolveCredential: () => supplied, scopes: ["write"] })).rejects.toMatchObject({ code: "AUTH_DENIED" });
});

test("admin MCP refuses every caller outside its allowlist before tools or database load", async () => {
  for (const [caller, status] of [[{ kind: "anonymous" }, 401], [user("admin,editor"), 403], [{ kind: "system", reason: "maintenance" }, 403], [{ kind: "future" }, 403]] as const) {
    const handle = mcp(() => { throw Error("tools loaded before admission"); }, { db: () => { throw Error("database loaded before admission"); }, caller: () => caller as Caller });
    const response = await handle(new Request("https://app.test/mcp/admin", { method: "POST", body: "invalid" }), {});
    expect(response!.status).toBe(status);
    expect(await handle(new Request("https://app.test/mcp/staff"), {})).toBeUndefined();
  }
});

const directory = resolve(import.meta.dir, "apps/.generated", `admin-layer-${crypto.randomUUID()}`);
afterAll(() => rm(directory, { recursive: true, force: true }));
test("generated role predicates, bare admin, Store and publishing use only the admin layer", async () => {
  const doc = (name: string, predicate: unknown) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind: "View", metadata: { name }, spec: { surface: "admin", sql: "SELECT id FROM posts ORDER BY id", requires: { auth: { all: [predicate] } } } });
  const sources = [...await loadFixtureSources("publishing.yaml"), { sourceId: "roles.yaml", text: [doc("editor-only", { "ctx.admin": ["editor"] }), doc("any-admin", "ctx.admin")].join("\n---\n") }];
  const files = await generateOrThrow("bun-sqlite", sources);
  await writeGenerated(directory, files);
  const app = await import(resolve(directory, "generated.ts")), db = new Database(":memory:");
  try {
    db.exec(files["schema.sql"]!);
    const row = await app.store(db, { kind: "system", reason: "fixture" }).collection("posts").insert({ title: "Draft" });
    for (const caller of [user("admin,editor"), user("editor")]) {
      for (const name of ["editor-only", "any-admin"]) await expect(app.views[name](db, caller, {})).rejects.toMatchObject({ code: "AUTH_DENIED" });
      expect(await app.store(db, caller).collection("posts").count()).toBe(0);
      await expect(app.procedures["posts.publish"](db, caller, { id: row.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "AUTH_DENIED" });
    }
    const admin = user("orgAdmin,editor", true);
    expect(await app.views["editor-only"](db, admin, {})).toHaveLength(1);
    expect(await app.views["any-admin"](db, user("orgAdmin", true), {})).toHaveLength(1);
    await expect(app.views["editor-only"](db, user("orgAdmin", true), {})).rejects.toMatchObject({ code: "AUTH_DENIED" });
    expect(await app.store(db, admin).collection("posts").count()).toBe(1);
    await app.procedures["posts.publish"](db, admin, { id: row.id, expectedVersion: 1 });
    expect(await app.store(db, user("editor")).collection("posts").count()).toBe(1);
  } finally { db.close(); }
});

test("admin role names have the ADR syntax and 63-character limit", async () => {
  for (const role of ["editor", "orgAdmin_2", "a".repeat(63)]) {
    const text = JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind: "View", metadata: { name: "roles" }, spec: { surface: "admin", requires: { auth: { all: [{ "ctx.admin": [role] }] } }, sql: "SELECT 1 AS value" } });
    expect((await generateOrThrow("bun-sqlite", [{ sourceId: "role.yaml", text }]))["generated.ts"]).toBeString();
  }
  for (const role of ["", "Editor", "two-roles", "two,roles", "é", "a".repeat(64)]) {
    const text = JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind: "View", metadata: { name: "roles" }, spec: { surface: "admin", requires: { auth: { all: [{ "ctx.admin": [role] }] } }, sql: "SELECT 1 AS value" } });
    await expect(generateOrThrow("bun-sqlite", [{ sourceId: "role.yaml", text }])).rejects.toThrow("^[a-z][a-zA-Z0-9_]{0,62}$");
  }
});
