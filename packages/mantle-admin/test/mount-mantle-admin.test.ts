import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan } from "@aotter/mantle-runtime";
import { mountMantleAdmin, type AdminAuth } from "../src/index.js";

const parsed = parseManifestSources({ sources: [] });
if (!parsed.ok) throw new Error("expected empty Admin fixture to parse");
const linked = linkManifestSet(parsed.value);
if (!linked.ok) throw new Error("expected empty Admin fixture to link");
const compiled = compileRuntimePlan(linked.value);
if (!compiled.ok) throw new Error("expected empty Admin fixture to compile");

const auth: AdminAuth = {
  basePath: "/api/auth",
  handler: async () => new Response(null, { status: 404 }),
  methods: [],
  getSession: async () => null,
  getUserRole: async () => null,
  listUsers: async () => [],
  listMembers: async () => ({ items: [], previousCursor: null, nextCursor: null }),
  setUserRole: async () => false,
  inviteUser: async () => ({ kind: "created", id: "invite" }),
  revokeInvite: async () => false,
};

describe("mountMantleAdmin", () => {
  it("mounts the selected SPA asset contract", async () => {
    const app = mounted();
    const response = await app.request("https://example.test/admin/settings");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("admin shell");
  });

  it("denies Admin APIs without a session", async () => {
    const response = await mounted().request("https://example.test/admin/api/me");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      diagnostic: { code: "UNAUTHENTICATED" },
    });
  });

  it("accepts staff and denies signed-in non-staff users", async () => {
    const session = async () => ({ session: { id: "session" }, user: { id: "user" } });
    const accepted = await mounted({
      getSession: session,
      getUserRole: async () => "owner",
    }).request("https://example.test/admin/api/me");
    expect(accepted.status).toBe(200);

    const denied = await mounted({
      getSession: session,
      getUserRole: async () => null,
    }).request("https://example.test/admin/api/me");
    expect(denied.status).toBe(403);
  });
});

function mounted(overrides: Partial<AdminAuth> = {}): Hono {
  const app = new Hono();
  mountMantleAdmin(app, {
    plan: compiled.value,
    auth: { ...auth, ...overrides },
    assets: { fetch: async () => new Response("admin shell") },
    get: async () => {
      throw new Error("runtime should stay lazy for shell/auth denial");
    },
  });
  return app;
}
