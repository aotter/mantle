import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
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
 * `/admin/api/operations` (#426) — staff-operable Procedure discovery
 * + invocation. Derivation rule under test: a Procedure is
 * staff-operable iff some Trigger targets it with
 *   (a) `source.kind: "mcp"` + `source.surface: "staff"`, or
 *   (b) `source.kind: "http"` AND the Procedure's `requires.auth.all`
 *       includes a `ctx.staff` predicate.
 * A Procedure reachable only via a plain public HTTP Trigger (no
 * `ctx.staff` predicate) must NOT appear.
 */

const apiVersion = "cms.mantle.aotter.net/v1" as const;

function manifests(): Manifest[] {
  return [
    // (a) MCP staff-surface trigger — staff-operable regardless of
    // the Procedure's own auth (surface controls discovery here).
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "recompute-inventory" },
      spec: {
        input: {
          type: "object",
          description: "Recompute cached inventory aggregates.",
          properties: { sku: { type: "string" } },
          required: ["sku"],
        },
        output: { type: "object" },
        handler: { kind: "ref", ref: "recomputeInventory" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "recompute-inventory-mcp" },
      spec: {
        source: { kind: "mcp", surface: "staff" },
        target: { procedure: "recompute-inventory" },
      },
    },
    // (b) Plain HTTP trigger + ctx.staff predicate — staff-operable.
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "reindex-catalog" },
      spec: {
        input: { type: "object" },
        output: { type: "object" },
        handler: { kind: "ref", ref: "reindexCatalog" },
        requires: { auth: { all: [{ "ctx.staff": ["owner", "editor"] }] } },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "reindex-catalog-http" },
      spec: {
        source: { kind: "http", method: "POST", path: "/api/reindex-catalog" },
        target: { procedure: "reindex-catalog" },
      },
    },
    // Plain public HTTP trigger, no ctx.staff predicate — must NOT
    // appear as a staff operation.
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "public-ping" },
      spec: {
        input: { type: "object" },
        output: { type: "object" },
        handler: { kind: "ref", ref: "publicPing" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "public-ping-http" },
      spec: {
        source: { kind: "http", method: "POST", path: "/api/ping" },
        target: { procedure: "public-ping" },
      },
    },
  ];
}

function sessionAsStaff(role = "editor") {
  return async () => ({
    session: { id: "s-1", userId: "user-1", expiresAt: new Date(Date.now() + 60_000) },
    user: {
      id: "user-1",
      email: "tester@example.com",
      name: "Tester",
      role,
      githubLogin: null,
    },
  });
}

function harness(authOverride?: Partial<Auth>) {
  const calls: Array<{ input: unknown }> = [];
  const auth: Auth = { ...stubAuth, getSession: sessionAsStaff(), ...authOverride };
  const ref = createCmsRef({
    manifests: manifests(),
    handlers: {
      recomputeInventory: (input) => {
        calls.push({ input });
        return { ok: true, sku: (input as { sku: string }).sku };
      },
      reindexCatalog: () => ({ ok: true }),
      publicPing: () => ({ ok: true }),
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
  return { app, calls };
}

describe("GET /admin/api/operations", () => {
  it("lists staff-operable procedures with name/description/input/triggers", async () => {
    const { app } = harness();
    const res = await app.request("/admin/api/operations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      operations: Array<{ name: string; description: string | null; triggers: string[] }>;
    };
    const names = body.operations.map((op) => op.name).sort();
    expect(names).toEqual(["recompute-inventory", "reindex-catalog"]);

    const recompute = body.operations.find((op) => op.name === "recompute-inventory")!;
    expect(recompute.description).toBe("Recompute cached inventory aggregates.");
    expect(recompute.triggers).toEqual(["mcp"]);

    const reindex = body.operations.find((op) => op.name === "reindex-catalog")!;
    expect(reindex.triggers).toEqual(["http"]);
  });

  it("does not list a plain public-HTTP-triggered procedure with no ctx.staff predicate", async () => {
    const { app } = harness();
    const res = await app.request("/admin/api/operations");
    const body = (await res.json()) as { operations: Array<{ name: string }> };
    expect(body.operations.some((op) => op.name === "public-ping")).toBe(false);
  });

  it("401s when unauthenticated", async () => {
    const { app } = harness({ getSession: async () => null });
    const res = await app.request("/admin/api/operations");
    expect(res.status).toBe(401);
  });
});

describe("POST /admin/api/operations/:name", () => {
  it("invokes the procedure through the runtime and returns its output", async () => {
    const { app, calls } = harness();
    const res = await app.request("/admin/api/operations/recompute-inventory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "sku-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; output?: { sku: string } };
    expect(body.ok).toBe(true);
    expect(body.output?.sku).toBe("sku-1");
    expect(calls).toEqual([{ input: { sku: "sku-1" } }]);
  });

  it("404s on an unknown operation name", async () => {
    const { app } = harness();
    const res = await app.request("/admin/api/operations/does-not-exist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { diagnostic?: { code: string } };
    expect(body.diagnostic?.code).toBe("NOT_FOUND");
  });

  it("404s on a procedure that exists but is not staff-operable", async () => {
    const { app } = harness();
    const res = await app.request("/admin/api/operations/public-ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    const { app } = harness({ getSession: async () => null });
    const res = await app.request("/admin/api/operations/recompute-inventory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "sku-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("surfaces the DiagnosticError shape when the procedure's own auth denies the caller", async () => {
    // reindex-catalog requires ctx.staff role owner|editor; a
    // contributor session should be denied by InvokeProcedureUseCase
    // itself, surfaced the same way other admin routes do.
    const { app } = harness({ getSession: sessionAsStaff("contributor") });
    const res = await app.request("/admin/api/operations/reindex-catalog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; diagnostic?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.diagnostic?.code).toBe("AUTH_DENIED");
  });
});
