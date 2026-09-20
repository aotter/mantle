import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMantleRuntimeRef } from "../src/mount/bootRuntimeOnce.js";
import { mountTestEndpoints } from "./mountTestEndpoints.js";
import { compileTestPlan } from "./compileTestPlan.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { StubAssetServer, stubAuth } from "./fakes/runtime-bindings.js";
import type { Auth } from "../src/auth/createAuth.js";

function harness(authOverride?: Partial<Auth>) {
  const auth: Auth = { ...stubAuth, ...authOverride };
  const ref = createMantleRuntimeRef({
    plan: compileTestPlan([]),
    handlers: {},
    bindings: {
      db: new InMemoryDatabase(),
      adminAssets: new StubAssetServer(),
    },
    auth,
  });
  const app = new Hono();
  mountTestEndpoints(app, ref);
  return { app, auth };
}

describe("mountTestEndpoints: /api/auth/* surface", () => {
  it("mounts no Admin or Auth namespace when Admin assets are omitted", async () => {
    const ref = createMantleRuntimeRef({
      plan: compileTestPlan([]),
      bindings: { db: new InMemoryDatabase() },
      auth: stubAuth,
    });
    const app = new Hono();
    mountTestEndpoints(app, ref);

    expect((await app.request("/admin")).status).toBe(404);
    expect((await app.request("/admin/api/me")).status).toBe(404);
    expect((await app.request("/api/auth/methods")).status).toBe(404);
  });

  it("returns registered methods before the Auth catch-all", async () => {
    const handlerCalls: Request[] = [];
    const { app } = harness({
      methods: [
        { kind: "social", provider: "github" },
        { kind: "magic-link" },
      ],
      handler: async (request) => {
        handlerCalls.push(request);
        return new Response("from-better-auth", { status: 418 });
      },
    });

    const response = await app.request("/api/auth/methods");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ methods: [
      { kind: "social", provider: "github" },
      { kind: "magic-link" },
    ] });
    expect(handlerCalls).toHaveLength(0);
  });

  it.each(["/api/auth", "/api/platform/auth"])("falls through to Auth under %s", async (basePath) => {
    const handlerCalls: Request[] = [];
    const { app } = harness({
      basePath,
      methods: [{ kind: "social", provider: "github" }],
      handler: async (request) => {
        handlerCalls.push(request);
        return new Response("ok-from-platform-auth");
      },
    });

    expect((await app.request(`${basePath}/methods`)).status).toBe(200);
    const response = await app.request(`${basePath}/sign-in/social`);
    expect(await response.text()).toBe("ok-from-platform-auth");
    expect(handlerCalls).toHaveLength(1);
  });
});
