import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { mountServerEndpoints } from "../src/mount/mountServerEndpoints.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
  InMemoryKv,
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";
import type { Auth, StaffUserInfo } from "../src/auth/createAuth.js";

/** /admin/api/staff* endpoint contract: owner-only gating, the
 *  self-role-change guard, input validation, and the conflict shapes
 *  for invitations. Auth-method behavior itself (D1 reads/writes) is
 *  covered by `createAuth.test.ts`-style unit tests; here `Auth` is a
 *  scripted fake and we assert the HTTP layer. */

function sessionAs(role: string | null, userId = "user-1") {
  return async () => ({
    session: { id: "s-1", userId, expiresAt: new Date(Date.now() + 60_000) },
    user: {
      id: userId,
      email: "tester@example.com",
      name: "Tester",
      role,
      githubLogin: null,
    },
  });
}

function harness(authOverride?: Partial<Auth>) {
  const getSession = authOverride?.getSession ?? stubAuth.getSession;
  const auth: Auth = {
    ...stubAuth,
    ...authOverride,
    getSession,
    getUserRole:
      authOverride?.getUserRole ??
      (async () => {
        const session = await getSession(new Request("https://example.test/"));
        return session?.user.role ?? null;
      }),
  };
  const ref = createCmsRef({
    manifests: [],
    handlers: {},
    bindings: {
      db: new InMemoryDatabase(),
      kv: new InMemoryKv(),
      assets: new StubAssetServer(),
    },
    auth,
  });
  const app = new Hono();
  mountServerEndpoints(app, ref);
  return { app };
}

const FIXTURE_USER: StaffUserInfo = {
  id: "user-2",
  email: "second@example.com",
  name: "second",
  role: null,
  githubLogin: null,
  emailVerified: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("GET /admin/api/staff", () => {
  it("401s with no session", async () => {
    const { app } = harness();
    const res = await app.request("/admin/api/staff");
    expect(res.status).toBe(401);
  });

  it("403s for editor — staff management is owner-only", async () => {
    const { app } = harness({ getSession: sessionAs("editor") });
    const res = await app.request("/admin/api/staff");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { diagnostic: { message: string } };
    expect(body.diagnostic.message).toMatch(/owner-only/i);
  });

  it("returns the user list for owner", async () => {
    const { app } = harness({
      getSession: sessionAs("owner"),
      listUsers: async () => [FIXTURE_USER],
    });
    const res = await app.request("/admin/api/staff");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ id: string }> };
    expect(body.users).toHaveLength(1);
    expect(body.users[0]!.id).toBe("user-2");
  });
});

describe("PATCH /admin/api/staff/:id/role", () => {
  it("rejects a non-staff role string with 400", async () => {
    const { app } = harness({ getSession: sessionAs("owner") });
    const res = await app.request(
      "/admin/api/staff/user-2/role",
      jsonInit("PATCH", { role: "superadmin" }),
    );
    expect(res.status).toBe(400);
  });

  it("accepts null to revoke staff access", async () => {
    const calls: Array<[string, string | null]> = [];
    const { app } = harness({
      getSession: sessionAs("owner"),
      setUserRole: async (userId, role) => {
        calls.push([userId, role]);
        return true;
      },
    });
    const res = await app.request(
      "/admin/api/staff/user-2/role",
      jsonInit("PATCH", { role: null }),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([["user-2", null]]);
  });

  it("403s when the owner targets their own row", async () => {
    const { app } = harness({ getSession: sessionAs("owner", "self-id") });
    const res = await app.request(
      "/admin/api/staff/self-id/role",
      jsonInit("PATCH", { role: "editor" }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { diagnostic: { message: string } };
    expect(body.diagnostic.message).toMatch(/own role/i);
  });

  it("404s when no row matched", async () => {
    const { app } = harness({
      getSession: sessionAs("owner"),
      setUserRole: async () => false,
    });
    const res = await app.request(
      "/admin/api/staff/ghost/role",
      jsonInit("PATCH", { role: "editor" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/api/staff/invitations", () => {
  it("validates email shape and staff role", async () => {
    const { app } = harness({ getSession: sessionAs("owner") });
    const badEmail = await app.request(
      "/admin/api/staff/invitations",
      jsonInit("POST", { email: "not-an-email", role: "editor" }),
    );
    expect(badEmail.status).toBe(400);
    const badRole = await app.request(
      "/admin/api/staff/invitations",
      jsonInit("POST", { email: "ok@example.com", role: "user" }),
    );
    expect(badRole.status).toBe(400);
  });

  it("creates an invitation and returns the new user id", async () => {
    const { app } = harness({
      getSession: sessionAs("owner"),
      inviteUser: async () => ({ kind: "created", id: "new-id" }),
    });
    const res = await app.request(
      "/admin/api/staff/invitations",
      jsonInit("POST", { email: "new@example.com", role: "contributor" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, userId: "new-id" });
  });

  it("409s when the email already has a row, carrying that row's id", async () => {
    const { app } = harness({
      getSession: sessionAs("owner"),
      inviteUser: async () => ({ kind: "exists", id: "old-id" }),
    });
    const res = await app.request(
      "/admin/api/staff/invitations",
      jsonInit("POST", { email: "dup@example.com", role: "editor" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, userId: "old-id" });
  });
});

describe("DELETE /admin/api/staff/invitations/:id", () => {
  it("409s when the row is not a never-signed-in invitation", async () => {
    const { app } = harness({
      getSession: sessionAs("owner"),
      revokeInvite: async () => false,
    });
    const res = await app.request("/admin/api/staff/invitations/user-2", {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
  });

  it("200s when the invitation was deleted", async () => {
    const { app } = harness({
      getSession: sessionAs("owner"),
      revokeInvite: async () => true,
    });
    const res = await app.request("/admin/api/staff/invitations/user-2", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
  });

  it("403s for contributor", async () => {
    const { app } = harness({ getSession: sessionAs("contributor") });
    const res = await app.request("/admin/api/staff/invitations/user-2", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
