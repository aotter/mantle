import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { mountServerEndpoints } from "../src/mount/mountServerEndpoints.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
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

function harness(
  authOverride?: Partial<Auth>,
  bindings: {
    readonly db?: InMemoryDatabase;
  } = {},
) {
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
  const db = bindings.db ?? new InMemoryDatabase();
  const ref = createCmsRef({
    manifests: [],
    handlers: {},
    bindings: {
      db,
      assets: new StubAssetServer(),
    },
    auth,
  });
  const app = new Hono();
  mountServerEndpoints(app, ref);
  return { app, db };
}

class OrderedDatabase extends InMemoryDatabase {
  constructor(
    private readonly events: string[],
    private readonly failWrites = false,
  ) {
    super();
  }

  override prepare(sql: string) {
    if (sql.replace(/\s+/g, " ").trim().startsWith("SELECT key, value FROM site_config")) {
      this.events.push("read");
    }
    return super.prepare(sql);
  }

  override async batch(stmts: Parameters<InMemoryDatabase["batch"]>[0]) {
    if (this.failWrites) {
      this.events.push("write-failed");
      throw new Error("scripted site settings write failure");
    }
    const result = await super.batch(stmts);
    this.events.push("write");
    return result;
  }
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

describe("GET /admin/api/site", () => {
  it("falls back to the request origin for every public URL", async () => {
    const { app } = harness({ getSession: sessionAs("owner") });
    const res = await app.request("https://example.test/admin/api/site");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      publicUrl: "https://example.test",
      mcpUrl: "https://example.test/mcp/staff",
    });
    expect(body).not.toHaveProperty("origin");
  });

  it("uses the configured custom domain for every public URL", async () => {
    const db = new InMemoryDatabase();
    db.siteConfig.set("origin", "https://www.example.com");
    const { app } = harness({ getSession: sessionAs("owner") }, { db });

    const res = await app.request("https://site.workers.dev/admin/api/site");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      publicUrl: "https://www.example.com",
      mcpUrl: "https://www.example.com/mcp/staff",
    });
    expect(body).not.toHaveProperty("origin");
  });
});

describe("/admin/api/site-settings", () => {
  it("loads settings once and keeps missing tracking ids as empty strings", async () => {
    const { app, db } = harness({ getSession: sessionAs("owner") });
    db.siteConfig.set("brand", "Mantle");
    db.siteConfig.set("title", "Mantle site");
    db.siteConfig.set("description", "Fast by default");
    db.siteConfig.set("origin", "https://www.example.com");

    const res = await app.request("/admin/api/site-settings");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      brand: "Mantle",
      title: "Mantle site",
      description: "Fast by default",
      ga4MeasurementId: "",
      facebookPixelId: "",
    });
    const reads = db.executions.filter(({ sql }) =>
      sql.startsWith("SELECT key, value FROM site_config")
    );
    expect(reads).toHaveLength(1);
  });

  it("writes one partial batch, then reads once", async () => {
    const events: string[] = [];
    const db = new OrderedDatabase(events);
    db.siteConfig.set("brand", "Old brand");
    db.siteConfig.set("title", "Keep title");
    db.siteConfig.set("description", "Old description");
    db.siteConfig.set("facebookPixelId", "123");
    const { app } = harness({ getSession: sessionAs("owner") }, { db });

    const res = await app.request(
      "/admin/api/site-settings",
      jsonInit("PATCH", {
        brand: "New brand",
        title: 42,
        description: "",
        ga4MeasurementId: "g-new1",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      brand: "New brand",
      title: "Keep title",
      description: "",
      ga4MeasurementId: "G-NEW1",
      facebookPixelId: "123",
    });
    expect(db.siteConfig.get("brand")).toBe("New brand");
    expect(db.siteConfig.get("title")).toBe("Keep title");
    expect(db.siteConfig.get("description")).toBe("");
    expect(db.siteConfig.get("ga4MeasurementId")).toBe("G-NEW1");
    expect(events).toEqual(["write", "read"]);
  });

  it("reloads when PATCH has no accepted fields", async () => {
    const events: string[] = [];
    const db = new OrderedDatabase(events);
    const { app } = harness({ getSession: sessionAs("owner") }, { db });

    const res = await app.request(
      "/admin/api/site-settings",
      jsonInit("PATCH", { title: 42, facebookPixelId: null }),
    );

    expect(res.status).toBe(200);
    expect(events).toEqual(["read"]);
  });

  it("rejects tracking IDs that would be silently ignored while rendering", async () => {
    const { app, db } = harness({ getSession: sessionAs("owner") });
    const res = await app.request(
      "/admin/api/site-settings",
      jsonInit("PATCH", { ga4MeasurementId: "not-a-ga-id" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      diagnostic: { code: "INPUT_VALIDATION_FAILED" },
    });
    expect(db.siteConfig.has("ga4MeasurementId")).toBe(false);
  });

  it("does not report success after a failed write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const writeEvents: string[] = [];
      const writeFailure = harness(
        { getSession: sessionAs("owner") },
        { db: new OrderedDatabase(writeEvents, true) },
      );
      const writeResponse = await writeFailure.app.request(
        "/admin/api/site-settings",
        jsonInit("PATCH", { brand: "Never lands" }),
      );
      expect(writeResponse.status).toBe(500);
      expect(writeEvents).toEqual(["write-failed"]);

    } finally {
      error.mockRestore();
    }
  });

  it("rejects editors because site settings are owner-only", async () => {
    const { app } = harness({ getSession: sessionAs("editor") });
    const res = await app.request("/admin/api/site-settings");
    expect(res.status).toBe(403);
  });
});

describe("built-in admin role boundaries", () => {
  it("rejects contributor publishing", async () => {
    const { app } = harness({ getSession: sessionAs("contributor") });
    const res = await app.request(
      "/admin/api/entries/entry-1/publish",
      jsonInit("POST", {}),
    );
    expect(res.status).toBe(403);
  });

  it("rejects contributor media access but lets editors reach media setup", async () => {
    const contributor = harness({ getSession: sessionAs("contributor") });
    expect((await contributor.app.request("/admin/api/media")).status).toBe(403);

    const editor = harness({ getSession: sessionAs("editor") });
    expect((await editor.app.request("/admin/api/media")).status).toBe(501);
  });
});

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
    expect(body.diagnostic.message).toMatch(/owner role/i);
  });

  it("rejects a revoked live role even when the session still says owner", async () => {
    const getUserRole = vi.fn(async () => null);
    const { app } = harness({
      getSession: sessionAs("owner"),
      getUserRole,
    });

    expect((await app.request("/admin/api/staff")).status).toBe(403);
    expect(getUserRole).toHaveBeenCalledWith("user-1");
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

describe("GET /admin/api/members", () => {
  it("allows editors and maps the member cursor envelope", async () => {
    const listMembers = vi.fn(async () => ({
      items: [{
        id: "member-1",
        email: "member@example.com",
        name: "Member",
        emailVerified: true,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }],
      previousCursor: null,
      nextCursor: "next",
    }));
    const { app } = harness({ getSession: sessionAs("editor"), listMembers });

    const res = await app.request("/admin/api/members?limit=25&search=member");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      items: [{ id: "member-1" }],
      previous_cursor: null,
      next_cursor: "next",
    });
    expect(listMembers).toHaveBeenCalledWith({
      limit: 25,
      search: "member",
      cursor: undefined,
      cursorDirection: "forward",
    });
  });

  it("rejects contributors and malformed cursors", async () => {
    const contributor = harness({ getSession: sessionAs("contributor") });
    expect((await contributor.app.request("/admin/api/members")).status).toBe(403);

    const editor = harness({ getSession: sessionAs("editor") });
    expect((await editor.app.request("/admin/api/members?cursor=broken")).status).toBe(400);
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

  it("assigns the requested staff role when the email already has an end-user row", async () => {
    const assigned: Array<[string, string | null]> = [];
    const { app } = harness({
      getSession: sessionAs("owner"),
      inviteUser: async () => ({ kind: "exists", id: "old-id" }),
      setUserRole: async (id, role) => {
        assigned.push([id, role]);
        return true;
      },
    });
    const res = await app.request(
      "/admin/api/staff/invitations",
      jsonInit("POST", { email: "dup@example.com", role: "editor" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, userId: "old-id" });
    expect(assigned).toEqual([["old-id", "editor"]]);
  });

  it("does not let an owner change their own role through the invite form", async () => {
    const setUserRole = vi.fn(async () => true);
    const { app } = harness({
      getSession: sessionAs("owner", "self-id"),
      inviteUser: async () => ({ kind: "exists", id: "self-id" }),
      setUserRole,
    });
    const res = await app.request(
      "/admin/api/staff/invitations",
      jsonInit("POST", { email: "self@example.com", role: "contributor" }),
    );
    expect(res.status).toBe(403);
    expect(setUserRole).not.toHaveBeenCalled();
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
