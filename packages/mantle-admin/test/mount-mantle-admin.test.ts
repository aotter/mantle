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

  it("projects the sealed manifest plan as logic nodes and edges", async () => {
    const response = await mounted({
      getSession: async () => ({ session: { id: "session" }, user: { id: "user" } }),
      getUserRole: async () => "owner",
    }, compilePlan(`
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  schema: { type: object, properties: { status: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: open-orders }
spec: { surface: staff, from: orders }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: place-order }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: placeOrder }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: place-order-http }
spec:
  source: { kind: http, method: POST, path: /api/orders }
  target: { procedure: place-order }
`)).request("https://example.test/admin/api/developer-console");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        atoms: { triggers: 1, procedures: 1, schemas: 1, views: 1 },
        interfaces: {
          httpRoutes: 1,
          mcpTools: 3,
          publicViews: 0,
          staffViews: 1,
          lifecycleBindings: 0,
        },
        explicitRelations: 2,
        opaqueHandlers: 1,
      },
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "Schema:orders", kind: "Schema", name: "orders" }),
        expect.objectContaining({ id: "Trigger:place-order-http", detail: "POST /api/orders" }),
      ]),
      edges: expect.arrayContaining([
        expect.objectContaining({ from: "Schema:orders", to: "View:open-orders", label: "reads" }),
        expect.objectContaining({ from: "Trigger:place-order-http", to: "Procedure:place-order", label: "invokes" }),
      ]),
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
