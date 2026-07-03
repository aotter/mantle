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
    // `spec.input.description` is DELIBERATELY set to something
    // DIFFERENT from `spec.description` so the tests below can prove
    // the wire `description` comes from `spec.description` (#430),
    // not the pre-#430 `spec.input.description` hack.
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "recompute-inventory" },
      spec: {
        title: "Recompute Inventory",
        description: "Recompute cached inventory aggregates.",
        input: {
          type: "object",
          description: "NOT the operation description — this is JSON Schema metadata.",
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
  it("lists staff-operable procedures with name/title/description/input/triggers/rowBindings", async () => {
    const { app } = harness();
    const res = await app.request("/admin/api/operations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      operations: Array<{
        name: string;
        title: string | null;
        description: string | null;
        triggers: string[];
        rowBindings: Array<{ collection: string; inputField: string; rowField: string }>;
      }>;
    };
    const names = body.operations.map((op) => op.name).sort();
    expect(names).toEqual(["recompute-inventory", "reindex-catalog"]);

    const recompute = body.operations.find((op) => op.name === "recompute-inventory")!;
    // Proves the old `spec.input.description` hack is gone: the fixture
    // sets `input.description` to a distinct string, so this assertion
    // would fail against the pre-#430 behavior.
    expect(recompute.title).toBe("Recompute Inventory");
    expect(recompute.description).toBe("Recompute cached inventory aggregates.");
    expect(recompute.triggers).toEqual(["mcp"]);
    expect(recompute.rowBindings).toEqual([]);

    const reindex = body.operations.find((op) => op.name === "reindex-catalog")!;
    expect(reindex.triggers).toEqual(["http"]);
    // No title/description declared on this fixture procedure — both
    // null, not the input-description hack value.
    expect(reindex.title).toBeNull();
    expect(reindex.description).toBeNull();
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

/**
 * `rowBindings` derivation (#430): a staff-operable Procedure's
 * `x-mantle-ref` input properties become row-action bindings so the
 * admin SPA can offer the operation from a collection row's "⋯" menu.
 * Uses its own manifest set (`rowBindingManifests`) rather than the
 * shared `manifests()`/`harness()` fixture above, since these cases
 * need Schema manifests in play that the base fixture doesn't declare.
 */
function rowBindingManifests(): Manifest[] {
  return [
    {
      apiVersion,
      kind: "Schema",
      metadata: { name: "products" },
      spec: {
        title: "Products",
        schema: { type: "object", properties: { sku: { type: "string" } } },
        uniqueIndexes: [["sku"]],
      },
    },
    {
      apiVersion,
      kind: "Schema",
      metadata: { name: "orders" },
      spec: {
        title: "Orders",
        schema: { type: "object", properties: { id: { type: "string" } } },
        // No uniqueIndexes declared — rowField must fall back to "id".
      },
    },
    {
      apiVersion,
      kind: "Schema",
      metadata: { name: "warehouses" },
      spec: {
        title: "Warehouses",
        schema: {
          type: "object",
          properties: { region: { type: "string" }, code: { type: "string" } },
        },
        // Composite (multi-field) unique index — rowField must fall
        // back to "id", not pick either field.
        uniqueIndexes: [["region", "code"]],
      },
    },
    {
      apiVersion,
      kind: "Schema",
      metadata: { name: "posts" },
      spec: {
        title: "Posts",
        localized: true,
        schema: { type: "object", properties: { slug: { type: "string" } } },
      },
    },
    {
      apiVersion,
      kind: "Schema",
      metadata: { name: "posts_i18n" },
      spec: {
        title: "Posts (translations)",
        localized: true,
        translates: { parent: "posts", on: "slug" },
        schema: { type: "object", properties: { slug: { type: "string" } } },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "resend-receipt" },
      spec: {
        title: "Resend Receipt",
        input: {
          type: "object",
          properties: {
            orderId: { type: "string", "x-mantle-ref": "orders" },
            warehouseId: { type: "string", "x-mantle-ref": "warehouses" },
          },
          required: ["orderId"],
        },
        output: { type: "object" },
        handler: { kind: "ref", ref: "resendReceipt" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "resend-receipt-mcp" },
      spec: {
        source: { kind: "mcp", surface: "staff" },
        target: { procedure: "resend-receipt" },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "restock-sku" },
      spec: {
        input: {
          type: "object",
          properties: { sku: { type: "string", "x-mantle-ref": "products" } },
          required: ["sku"],
        },
        output: { type: "object" },
        handler: { kind: "ref", ref: "restockSku" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "restock-sku-mcp" },
      spec: {
        source: { kind: "mcp", surface: "staff" },
        target: { procedure: "restock-sku" },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "audit-warehouse" },
      spec: {
        input: {
          type: "object",
          // `code` exists as a property on `warehouses` (whose unique
          // index is composite): same-name must win over the id
          // fallback — the input wants the code value, not an entry id.
          properties: { code: { type: "string", "x-mantle-ref": "warehouses" } },
          required: ["code"],
        },
        output: { type: "object" },
        handler: { kind: "ref", ref: "auditWarehouse" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "audit-warehouse-mcp" },
      spec: {
        source: { kind: "mcp", surface: "staff" },
        target: { procedure: "audit-warehouse" },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "unknown-ref-op" },
      spec: {
        input: {
          type: "object",
          properties: { thing: { type: "string", "x-mantle-ref": "does-not-exist" } },
        },
        output: { type: "object" },
        handler: { kind: "ref", ref: "unknownRefOp" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "unknown-ref-op-mcp" },
      spec: {
        source: { kind: "mcp", surface: "staff" },
        target: { procedure: "unknown-ref-op" },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "translate-post" },
      spec: {
        input: {
          type: "object",
          properties: { postSlug: { type: "string", "x-mantle-ref": "posts_i18n" } },
        },
        output: { type: "object" },
        handler: { kind: "ref", ref: "translatePost" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "translate-post-mcp" },
      spec: {
        source: { kind: "mcp", surface: "staff" },
        target: { procedure: "translate-post" },
      },
    },
  ];
}

function rowBindingHarness() {
  const auth: Auth = { ...stubAuth, getSession: sessionAsStaff() };
  const ref = createCmsRef({
    manifests: rowBindingManifests(),
    handlers: {
      resendReceipt: () => ({ ok: true }),
      restockSku: () => ({ ok: true }),
      auditWarehouse: () => ({ ok: true }),
      unknownRefOp: () => ({ ok: true }),
      translatePost: () => ({ ok: true }),
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
  return { app };
}

describe("GET /admin/api/operations — rowBindings (#430)", () => {
  it("prefers a same-name target property over the id fallback", async () => {
    const { app } = rowBindingHarness();
    const res = await app.request("/admin/api/operations");
    const body = (await res.json()) as {
      operations: Array<{
        name: string;
        rowBindings: Array<{ collection: string; inputField: string; rowField: string }>;
      }>;
    };
    // warehouses has a composite unique index (no single-field
    // derivation) BUT declares a `code` property — the binding must
    // use `code`, not fall back to `id`.
    const audit = body.operations.find((op) => op.name === "audit-warehouse")!;
    expect(audit.rowBindings).toEqual([
      { collection: "warehouses", inputField: "code", rowField: "code" },
    ]);
  });

  it("binds a single-field unique-index target to that field", async () => {
    const { app } = rowBindingHarness();
    const res = await app.request("/admin/api/operations");
    const body = (await res.json()) as {
      operations: Array<{
        name: string;
        rowBindings: Array<{ collection: string; inputField: string; rowField: string }>;
      }>;
    };
    const restock = body.operations.find((op) => op.name === "restock-sku")!;
    expect(restock.rowBindings).toEqual([
      { collection: "products", inputField: "sku", rowField: "sku" },
    ]);
  });

  it("falls back to rowField 'id' when the target has no uniqueIndexes, and skips composite indexes the same way", async () => {
    const { app } = rowBindingHarness();
    const res = await app.request("/admin/api/operations");
    const body = (await res.json()) as {
      operations: Array<{
        name: string;
        rowBindings: Array<{ collection: string; inputField: string; rowField: string }>;
      }>;
    };
    const resend = body.operations.find((op) => op.name === "resend-receipt")!;
    // `orders` has no uniqueIndexes → "id". `warehouses` has a
    // composite (2-field) unique index → also "id", not either field.
    expect(resend.rowBindings).toEqual(
      expect.arrayContaining([
        { collection: "orders", inputField: "orderId", rowField: "id" },
        { collection: "warehouses", inputField: "warehouseId", rowField: "id" },
      ]),
    );
    expect(resend.rowBindings).toHaveLength(2);
  });

  it("produces no binding (and no error) when x-mantle-ref points at an unknown schema name", async () => {
    const { app } = rowBindingHarness();
    const res = await app.request("/admin/api/operations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      operations: Array<{
        name: string;
        rowBindings: Array<{ collection: string; inputField: string; rowField: string }>;
      }>;
    };
    const op = body.operations.find((o) => o.name === "unknown-ref-op")!;
    expect(op.rowBindings).toEqual([]);
  });

  it("produces no binding when x-mantle-ref points at a translates (translation-child) schema", async () => {
    const { app } = rowBindingHarness();
    const res = await app.request("/admin/api/operations");
    const body = (await res.json()) as {
      operations: Array<{
        name: string;
        rowBindings: Array<{ collection: string; inputField: string; rowField: string }>;
      }>;
    };
    const op = body.operations.find((o) => o.name === "translate-post")!;
    expect(op.rowBindings).toEqual([]);
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
