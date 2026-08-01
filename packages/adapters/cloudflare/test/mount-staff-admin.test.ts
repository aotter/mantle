import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
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

function harness(
  authOverride?: Partial<Auth>,
  bindings: {
    readonly db?: InMemoryDatabase;
    readonly kv?: InMemoryKv;
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
  const kv = bindings.kv ?? new InMemoryKv();
  const ref = createCmsRef({
    manifests: [],
    handlers: {},
    bindings: {
      db,
      kv,
      assets: new StubAssetServer(),
    },
    auth,
  });
  const app = new Hono();
  mountServerEndpoints(app, ref);
  return { app, db, kv };
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

class OrderedKv extends InMemoryKv {
  constructor(
    private readonly events: string[],
    private readonly failInvalidation = false,
  ) {
    super();
  }

  override async list(prefix: string) {
    this.events.push("invalidate");
    if (this.failInvalidation) {
      throw new Error("scripted site settings invalidation failure");
    }
    return super.list(prefix);
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
  it("returns the Staff MCP endpoint for connector setup", async () => {
    const { app } = harness({ getSession: sessionAs("owner") });
    const res = await app.request("https://example.test/admin/api/site");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mcpUrl: "https://example.test/mcp/staff",
    });
  });
});

describe("/admin/api/site-settings", () => {
  it("loads settings once and keeps missing tracking ids as empty strings", async () => {
    const { app, db } = harness({ getSession: sessionAs("editor") });
    db.siteConfig.set("brand", "Mantle");
    db.siteConfig.set("title", "Mantle site");
    db.siteConfig.set("description", "Fast by default");

    const res = await app.request("/admin/api/site-settings");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
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

  it("writes one partial batch before invalidation, then reads once", async () => {
    const events: string[] = [];
    const db = new OrderedDatabase(events);
    const kv = new OrderedKv(events);
    db.siteConfig.set("brand", "Old brand");
    db.siteConfig.set("title", "Keep title");
    db.siteConfig.set("description", "Old description");
    db.siteConfig.set("facebookPixelId", "123");
    await kv.put("entry:html:en/posts/old", "old entry");
    await kv.put("list:html:posts:en", "old list");
    await kv.put("llms:en", "old llms");
    const { app } = harness(
      { getSession: sessionAs("editor") },
      { db, kv },
    );

    const res = await app.request(
      "/admin/api/site-settings",
      jsonInit("PATCH", {
        brand: "New brand",
        title: 42,
        description: "",
        ga4MeasurementId: "G-NEW",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      brand: "New brand",
      title: "Keep title",
      description: "",
      ga4MeasurementId: "G-NEW",
      facebookPixelId: "123",
    });
    expect(db.siteConfig.get("brand")).toBe("New brand");
    expect(db.siteConfig.get("title")).toBe("Keep title");
    expect(db.siteConfig.get("description")).toBe("");
    expect(db.siteConfig.get("ga4MeasurementId")).toBe("G-NEW");
    expect(events).toEqual([
      "write",
      "invalidate",
      "invalidate",
      "invalidate",
      "read",
    ]);
    await expect(kv.get("entry:html:en/posts/old")).resolves.toBeNull();
    await expect(kv.get("list:html:posts:en")).resolves.toBeNull();
    await expect(kv.get("llms:en")).resolves.toBeNull();
  });

  it("does not cross failed write or invalidation boundaries", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const writeEvents: string[] = [];
      const writeFailure = harness(
        { getSession: sessionAs("editor") },
        {
          db: new OrderedDatabase(writeEvents, true),
          kv: new OrderedKv(writeEvents),
        },
      );
      const writeResponse = await writeFailure.app.request(
        "/admin/api/site-settings",
        jsonInit("PATCH", { brand: "Never lands" }),
      );
      expect(writeResponse.status).toBe(500);
      expect(writeEvents).toEqual(["write-failed"]);

      const invalidationEvents: string[] = [];
      const invalidationFailure = harness(
        { getSession: sessionAs("editor") },
        {
          db: new OrderedDatabase(invalidationEvents),
          kv: new OrderedKv(invalidationEvents, true),
        },
      );
      const invalidationResponse = await invalidationFailure.app.request(
        "/admin/api/site-settings",
        jsonInit("PATCH", { brand: "Write lands" }),
      );
      expect(invalidationResponse.status).toBe(500);
      expect(invalidationEvents).toEqual([
        "write",
        "invalidate",
        "invalidate",
        "invalidate",
      ]);
    } finally {
      error.mockRestore();
    }
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
