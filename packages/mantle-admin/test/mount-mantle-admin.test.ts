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
  uiSchema: { collectionAction: orders }
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
      summary: {
        atoms: { triggers: 1, procedures: 1, schemas: 1, views: 1 },
      },
      dataModel: {
        schemas: [expect.objectContaining({
          name: "orders",
          lifecycle: "operational",
          localized: false,
          uniqueIndexes: [["customerId", "state"]],
          indexes: [["state"]],
          searchableFields: ["state"],
          schema: expect.objectContaining({ required: ["state"] }),
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
      surfaces: expect.arrayContaining([
        expect.objectContaining({ kind: "http", name: "POST /api/orders", ownerId: "Trigger:place-order-http" }),
        expect.objectContaining({ kind: "mcp", ownerId: "Schema:orders", visibility: "staff" }),
        expect.objectContaining({ kind: "view", name: "open-orders", ownerId: "View:open-orders" }),
      ]),
      limitations: {
        opaqueProcedures: ["place-order"],
        nativeViews: [],
      },
    });
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
