import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan, type RuntimePlan } from "@aotter/mantle-runtime";
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
    expect((await app.request("https://example.test/admin/dev")).status).toBe(200);
    expect((await app.request("https://example.test/admin/dev/docs")).status).toBe(200);
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

  it("projects exact schema and view definitions from the sealed plan", async () => {
    const response = await mounted({
      getSession: async () => ({ session: { id: "session" }, user: { id: "user" } }),
      getUserRole: async () => "owner",
    }, compilePlan(`
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  lifecycle: operational
  schema:
    type: object
    required: [state]
    properties:
      state: { type: string, enum: [open, paid] }
      customerId: { type: string }
  uniqueIndexes: [[customerId, state]]
  indexes: [[state]]
  searchableFields: [state]
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: open-orders }
spec:
  surface: staff
  from: orders
  fields: [state, customerId]
  orderBy: [{ field: state, direction: desc }]
  requires: { auth: { all: [ctx.user] } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: place-order }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: placeOrder }
  requires: { auth: { all: [ctx.user] } }
  uiSchema: { collectionAction: orders }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: create-order }
spec:
  input:
    type: object
    properties:
      customerId: { type: string }
      state: { type: string }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: orders }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: place-order-http }
spec:
  source: { kind: http, method: POST, path: /api/orders }
  target: { procedure: place-order }
`)).request("https://example.test/admin/api/developer-console");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      dataModel: {
        schemas: [expect.objectContaining({
          name: "orders",
          lifecycle: "operational",
          localized: false,
          uniqueIndexes: [["customerId", "state"]],
          indexes: [["state"]],
          searchableFields: ["state"],
          schema: expect.objectContaining({ required: ["state"] }),
          manifest: expect.objectContaining({ kind: "Schema", metadata: { name: "orders" } }),
        })],
        views: [expect.objectContaining({
          name: "open-orders",
          surface: "staff",
          authorization: ["ctx.user"],
          guard: null,
          query: {
            kind: "declarative",
            from: "orders",
            fields: ["state", "customerId"],
            orderBy: [{ field: "state", direction: "desc" }],
          },
        })],
      },
      logic: {
        triggers: [expect.objectContaining({
          name: "place-order-http",
          target: "place-order",
          audience: "members",
          source: { kind: "http", method: "POST", path: "/api/orders" },
          manifest: expect.objectContaining({ kind: "Trigger" }),
        })],
        procedures: expect.arrayContaining([
          expect.objectContaining({
            name: "place-order",
            audience: "members",
            authorization: ["ctx.user"],
            guard: null,
            handler: { kind: "ref", ref: "placeOrder" },
            input: { type: "object" },
            output: { type: "object" },
          }),
          expect.objectContaining({
            name: "create-order",
            handler: { kind: "builtin", op: "create", schema: "orders" },
          }),
        ]),
      },
      graph: {
        atoms: expect.arrayContaining([
          expect.objectContaining({ id: "Schema:orders", kind: "Schema" }),
          expect.objectContaining({ id: "View:open-orders", kind: "View", audience: "staff" }),
          expect.objectContaining({ id: "Procedure:place-order", kind: "Procedure", audience: "members", handler: { kind: "ref", ref: "placeOrder" } }),
          expect.objectContaining({ id: "Procedure:create-order", kind: "Procedure", handler: { kind: "builtin", op: "create", schema: "orders" } }),
          expect.objectContaining({ id: "Trigger:place-order-http", kind: "Trigger", audience: "members", transport: "http" }),
        ]),
        relations: expect.arrayContaining([
          expect.objectContaining({ kind: "view-source", sourceId: "View:open-orders", targetId: "Schema:orders", pointer: "/spec/from", value: "orders" }),
          expect.objectContaining({ kind: "collection-action", sourceId: "Procedure:place-order", targetId: "Schema:orders", pointer: "/spec/uiSchema/collectionAction", value: "orders" }),
          expect.objectContaining({ kind: "procedure-schema", sourceId: "Procedure:create-order", targetId: "Schema:orders", pointer: "/spec/handler/schema", value: "orders" }),
          expect.objectContaining({ kind: "trigger-target", sourceId: "Trigger:place-order-http", targetId: "Procedure:place-order", pointer: "/spec/target/procedure", value: "place-order" }),
        ]),
      },
    });
  });

  it("projects HTTP, MCP, and server-backed WebMCP documentation from the plan", async () => {
    const app = mounted({
      getSession: async () => ({ session: { id: "session" }, user: { id: "user" } }),
      getUserRole: async () => "owner",
    }, compilePlan(`
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: inquiries }
spec:
  title: Inquiries
  lifecycle: operational
  schema:
    type: object
    required: [email]
    properties: { email: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: public-inquiries }
spec: { surface: public, from: inquiries, fields: [email] }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: submit-inquiry }
spec:
  input: { type: object, properties: { email: { type: string } } }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: inquiries }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: submit-inquiry-http }
spec: { source: { kind: http, method: POST, path: /api/inquiries }, target: { procedure: submit-inquiry } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: submit-inquiry-mcp }
spec: { source: { kind: mcp, surface: public }, target: { procedure: submit-inquiry } }
`));
    const response = await app.request("https://example.test/admin/api/developer-console");

    const body = await response.json();
    expect(body.interfaces.http).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "procedure", name: "submit-inquiry-http", method: "POST", path: "/api/inquiries", audience: "public" }),
      expect.objectContaining({ kind: "view", name: "query_view_public_inquiries", method: "GET", path: "/api/views/public-inquiries", audience: "public" }),
    ]));
    expect(body.interfaces.callable).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "procedure", name: "submit_inquiry", target: "submit-inquiry", trigger: "submit-inquiry-mcp", surface: "public", audience: "public" }),
      expect.objectContaining({ kind: "view", name: "query_view_public_inquiries", target: "public-inquiries", trigger: null, surface: "public", audience: "public" }),
    ]));
    await expect((await app.request("https://example.test/admin/api/views-manifest")).json()).resolves.toMatchObject({
      views: [expect.objectContaining({ name: "public-inquiries", surface: "public", from: "inquiries" })],
    });
  });

  it("keeps schema relationship provenance in the developer graph", async () => {
    const response = await mounted({
      getSession: async () => ({ session: { id: "session" }, user: { id: "user" } }),
      getUserRole: async () => "owner",
    }, compilePlan(`
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: products }
spec:
  title: Products
  schema:
    type: object
    required: [slug]
    properties: { slug: { type: string } }
  uniqueIndexes: [[slug]]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: product-translations }
spec:
  title: Product translations
  localized: true
  translates: { parent: products, on: slug }
  schema:
    type: object
    required: [slug, locale, title]
    properties:
      slug: { type: string }
      locale: { type: string }
      title: { type: string }
  uniqueIndexes: [[slug, locale]]
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: reviews }
spec:
  title: Reviews
  schema:
    type: object
    required: [productId]
    properties:
      productId: { type: string, x-mantle-ref: products }
`)).request("https://example.test/admin/api/developer-console");

    const body = await response.json();
    expect(body.graph.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "translation-parent", sourceId: "Schema:product-translations", targetId: "Schema:products", pointer: "/spec/translates/parent", value: "products" }),
      expect.objectContaining({ kind: "schema-reference", sourceId: "Schema:reviews", targetId: "Schema:products", pointer: "/spec/schema/properties/productId/x-mantle-ref", value: "products" }),
    ]));
  });
});

function mounted(overrides: Partial<AdminAuth> = {}, plan: RuntimePlan = compiled.value): Hono {
  const app = new Hono();
  mountMantleAdmin(app, {
    plan,
    auth: { ...auth, ...overrides },
    assets: { fetch: async () => new Response("admin shell") },
    get: async () => {
      throw new Error("runtime should stay lazy for shell/auth denial");
    },
  });
  return app;
}

function compilePlan(text: string): RuntimePlan {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:test", text }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error("expected Admin logic fixture to compile");
  return compiled.value;
}
