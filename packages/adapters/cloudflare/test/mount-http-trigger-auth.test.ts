import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  DiagnosticError,
  runtimeDiagnostic,
  type Manifest,
} from "@aotter/mantle-spec";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { mountServerEndpoints } from "../src/mount/mountServerEndpoints.js";
import type { Auth } from "../src/auth/createAuth.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
  InMemoryKv,
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";

/**
 * HTTP Trigger auth-context plumbing (#299). The pre-alpha.16 build
 * hardcoded `{ user: null, staff: null }` for HTTP Trigger calls, so
 * any Procedure that declared `requires.auth.all: [{ "ctx.staff": [...] }]`
 * was unreachable over HTTP regardless of the caller's role. The
 * fix mirrors `buildViewCtx`: cookie session resolves to a real
 * caller context, and the handler distinguishes 401 (no session)
 * from 403 (session, wrong role) — same shape as `handleViewRequest`.
 */

const apiVersion = "cms.mantle.aotter.net/v1" as const;

function staffGatedManifests(): Manifest[] {
  return [
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "staff-only-op" },
      spec: {
        input: { type: "object" },
        output: { type: "object" },
        handler: { kind: "ref", ref: "staffOnlyOp" },
        requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "staff-only-http" },
      spec: {
        source: { kind: "http", method: "POST", path: "/api/staff-only" },
        target: { procedure: "staff-only-op" },
      },
    },
  ];
}

interface AuthFakeOpts {
  readonly role: string | null;
  readonly userId?: string;
}

function authFake(opts: AuthFakeOpts | null): Auth {
  if (opts === null) return stubAuth;
  const userId = opts.userId ?? "u-1";
  return {
    ...stubAuth,
    getSession: async () => ({
      session: {
        id: "s-1",
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: {
        id: userId,
        email: `${userId}@example.test`,
        name: "Test",
        role: opts.role,
        githubLogin: null,
      },
    }),
    getUserRole: async () => opts.role,
  };
}

function buildApp(auth: Auth): Hono {
  const opCalls: Array<unknown> = [];
  const ref = createCmsRef({
    manifests: staffGatedManifests(),
    handlers: {
      staffOnlyOp: (input) => {
        opCalls.push(input);
        return { ok: true };
      },
    },
    bindings: {
      db: new InMemoryDatabase(),
      kv: new InMemoryKv(),
      assets: new StubAssetServer(),
    },
    auth,
  });
  const app = new Hono();
  mountServerEndpoints(app, ref);
  return app;
}

describe("mountServerEndpoints: HTTP Trigger ctx plumbing (#299)", () => {
  it("binds decoded path params once, keeps them authoritative, and still validates the full Procedure input (#530, #531)", async () => {
    let resolverCalls = 0;
    const inputs: unknown[] = [];
    const manifests: Manifest[] = [
      {
        apiVersion,
        kind: "Procedure",
        metadata: { name: "reserve-site" },
        spec: {
          input: {
            type: "object",
            properties: {
              siteId: { type: "string", minLength: 1 },
              operationId: { type: "string", minLength: 1 },
            },
            required: ["siteId", "operationId"],
          },
          output: { type: "object" },
          handler: { kind: "ref", ref: "reserveSite" },
          requires: { auth: { all: ["ctx.auth"] } },
        },
      },
      {
        apiVersion,
        kind: "Trigger",
        metadata: { name: "reserve-site-http" },
        spec: {
          source: { kind: "http", method: "POST", path: "/api/sites/{siteId}/reserve" },
          target: { procedure: "reserve-site" },
        },
      },
    ];
    const ref = createCmsRef({
      manifests,
      handlers: {
        reserveSite: (input) => {
          inputs.push(input);
          return {};
        },
      },
      bindings: {
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      },
      auth: stubAuth,
      credentialResolver: () => {
        resolverCalls++;
        return {
          kind: "verified",
          credential: {
            credential: "api-key",
            credentialId: "key-1",
            userId: null,
            scopes: [],
          },
        };
      },
    });
    const app = new Hono();
    mountServerEndpoints(app, ref);

    const granted = await app.request("/api/sites/site%20one/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ siteId: "spoofed", operationId: "op-1" }),
    });
    expect(granted.status).toBe(200);
    expect(inputs).toEqual([{ siteId: "site one", operationId: "op-1" }]);
    expect(resolverCalls).toBe(1);

    const missingBodyField = await app.request("/api/sites/site-one/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missingBodyField.status).toBe(400);
    expect((await missingBodyField.json()) as object).toMatchObject({
      diagnostic: { code: "INPUT_VALIDATION_FAILED" },
    });
    expect(inputs).toHaveLength(1);
    expect(resolverCalls).toBe(2);

    const malformedPath = await app.request("/api/sites/%GG/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: "op-2" }),
    });
    expect(malformedPath.status).toBe(400);
    expect(inputs).toHaveLength(1);
    expect(resolverCalls).toBe(3);
  });

  it("returns 401 UNAUTHENTICATED when no session and Procedure requires auth", async () => {
    const app = buildApp(authFake(null));
    const res = await app.request("/api/staff-only", { method: "POST" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      ok: boolean;
      diagnostic?: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.diagnostic?.code).toBe("UNAUTHENTICATED");
  });

  it("returns 403 AUTH_DENIED when session exists but role is null (customer)", async () => {
    const app = buildApp(authFake({ role: null }));
    const res = await app.request("/api/staff-only", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      ok: boolean;
      diagnostic?: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.diagnostic?.code).toBe("AUTH_DENIED");
  });

  it("returns 403 AUTH_DENIED when session exists with a non-staff role", async () => {
    const app = buildApp(authFake({ role: "customer" }));
    const res = await app.request("/api/staff-only", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { diagnostic?: { code: string } };
    expect(body.diagnostic?.code).toBe("AUTH_DENIED");
  });

  it("allows the call through when session has the required staff role (this is the #299 regression case)", async () => {
    const app = buildApp(authFake({ role: "owner" }));
    const res = await app.request("/api/staff-only", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data?: unknown };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ ok: true });
  });

  it("allows a signed-in customer through `ctx.user` predicate (no staff required)", async () => {
    // `requires.auth.all: ["ctx.user"]` means "any signed-in user".
    // A customer session (role: null) should pass, distinguishing
    // ctx.user (signed-in) from ctx.staff (signed-in + role).
    const userOnlyManifests: Manifest[] = [
      {
        apiVersion,
        kind: "Procedure",
        metadata: { name: "user-only-op" },
        spec: {
          input: { type: "object" },
          output: { type: "object" },
          handler: { kind: "ref", ref: "userOnlyOp" },
          requires: { auth: { all: ["ctx.user"] } },
        },
      },
      {
        apiVersion,
        kind: "Trigger",
        metadata: { name: "user-only-http" },
        spec: {
          source: { kind: "http", method: "POST", path: "/api/user-only" },
          target: { procedure: "user-only-op" },
        },
      },
    ];
    const ref = createCmsRef({
      manifests: userOnlyManifests,
      handlers: { userOnlyOp: () => ({ ok: true }) },
      bindings: {
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      },
      auth: authFake({ role: null }),
    });
    const app = new Hono();
    mountServerEndpoints(app, ref);
    const res = await app.request("/api/user-only", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("rejects a bearer token when OAuth bearer verification is not configured", async () => {
    const app = buildApp(authFake(null));
    const res = await app.request("/api/staff-only", {
      method: "POST",
      headers: { authorization: "Bearer some-token" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { diagnostic?: { code: string } };
    expect(body.diagnostic?.code).toBe("UNAUTHENTICATED");
  });

  it("authenticates a configured OAuth bearer and enforces manifest scopes", async () => {
    const scoped: Manifest[] = [
      {
        apiVersion,
        kind: "Procedure",
        metadata: { name: "scoped-op" },
        spec: {
          input: { type: "object" },
          output: { type: "object" },
          requires: {
            auth: { all: ["ctx.auth", { "ctx.auth.scope": "orders:read" }] },
          },
          handler: { kind: "ref", ref: "scopedOp" },
        },
      },
      {
        apiVersion,
        kind: "Trigger",
        metadata: { name: "scoped-http" },
        spec: {
          source: { kind: "http", method: "POST", path: "/api/scoped" },
          target: { procedure: "scoped-op" },
        },
      },
    ];
    let scopes: readonly string[] = ["orders:read"];
    const auth: Auth = {
      ...stubAuth,
      verifyOAuthAccessToken: async () => ({
        ok: true,
        userId: "user-1",
        clientId: "client-1",
        credentialId: "jti-1",
        scopes,
      }),
    };
    const ref = createCmsRef({
      manifests: scoped,
      handlers: { scopedOp: () => ({ ok: true }) },
      bindings: {
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      },
      auth,
      oauthBearer: { audience: "https://api.example.test" },
    });
    const app = new Hono();
    mountServerEndpoints(app, ref);
    const request = () =>
      app.request("/api/scoped", {
        method: "POST",
        headers: { authorization: "Bearer header.payload.signature" },
      });

    expect((await request()).status).toBe(200);
    scopes = [];
    const denied = await request();
    expect(denied.status).toBe(403);
    expect((await denied.json()) as object).toMatchObject({
      diagnostic: { code: "AUTH_DENIED" },
    });
  });

  it("runs a mutable site-owned paid guard for a verified API key on every call", async () => {
    let entitled = true;
    let targetCalls = 0;
    const manifests: Manifest[] = [
      {
        apiVersion,
        kind: "Procedure",
        metadata: { name: "require-active-access" },
        spec: {
          input: {
            type: "object",
            properties: { orderId: { type: "string" } },
            required: ["orderId"],
          },
          output: { type: "object" },
          handler: { kind: "ref", ref: "requireActiveAccess" },
        },
      },
      {
        apiVersion,
        kind: "Procedure",
        metadata: { name: "read-order" },
        spec: {
          input: {
            type: "object",
            properties: { orderId: { type: "string" } },
            required: ["orderId"],
          },
          output: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
          requires: {
            auth: {
              all: ["ctx.auth", { "ctx.auth.scope": "orders:read" }],
            },
            guard: { procedure: "require-active-access" },
          },
          handler: { kind: "ref", ref: "readOrder" },
        },
      },
      {
        apiVersion,
        kind: "Trigger",
        metadata: { name: "read-order-http" },
        spec: {
          source: { kind: "http", method: "POST", path: "/api/orders/read" },
          target: { procedure: "read-order" },
        },
      },
    ];
    const ref = createCmsRef({
      manifests,
      handlers: {
        requireActiveAccess: (_input, ctx) => {
          expect(ctx.auth?.credentialId).toBe("api-key-row-1");
          if (!entitled) {
            throw new DiagnosticError(
              runtimeDiagnostic({
                code: "ENTITLEMENT_REQUIRED",
                severity: "error",
                path: "site:transactions/api-key-row-1",
                message: "An active paid transaction is required.",
              }),
            );
          }
          return {};
        },
        readOrder: () => {
          targetCalls++;
          return { ok: true };
        },
      },
      bindings: {
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      },
      auth: authFake(null),
      credentialResolver: (request) => {
        const key = request.headers.get("x-api-key");
        if (key === null) return { kind: "not-handled" };
        if (key !== "site-secret") return { kind: "invalid" };
        return {
          kind: "verified",
          credential: {
            credential: "api-key",
            credentialId: "api-key-row-1",
            userId: null,
            scopes: ["orders:read"],
          },
        };
      },
    });
    const app = new Hono();
    mountServerEndpoints(app, ref);

    const request = () =>
      app.request("/api/orders/read", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "site-secret" },
        body: JSON.stringify({ orderId: "order-1" }),
      });
    const granted = await request();
    expect(granted.status).toBe(200);
    expect(targetCalls).toBe(1);

    entitled = false;
    const revoked = await request();
    expect(revoked.status).toBe(402);
    expect((await revoked.json()) as object).toMatchObject({
      diagnostic: { code: "ENTITLEMENT_REQUIRED" },
    });
    expect(targetCalls).toBe(1);
  });

  it("falls back to a guest ctx (no 401) when Procedure has no requires.auth", async () => {
    // Procedures without requires.auth must remain reachable
    // anonymously — the 401 pre-check only fires when the manifest
    // explicitly opts in.
    const openManifests: Manifest[] = [
      {
        apiVersion,
        kind: "Procedure",
        metadata: { name: "open-op" },
        spec: {
          input: { type: "object" },
          output: { type: "object" },
          handler: { kind: "ref", ref: "openOp" },
        },
      },
      {
        apiVersion,
        kind: "Trigger",
        metadata: { name: "open-http" },
        spec: {
          source: { kind: "http", method: "POST", path: "/api/open" },
          target: { procedure: "open-op" },
        },
      },
    ];
    const ref = createCmsRef({
      manifests: openManifests,
      handlers: { openOp: () => ({ ok: true }) },
      bindings: {
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      },
      auth: authFake(null),
    });
    const app = new Hono();
    mountServerEndpoints(app, ref);
    const res = await app.request("/api/open", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
