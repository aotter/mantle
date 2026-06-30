import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { mountServerEndpoints } from "../src/mount/mountServerEndpoints.js";
import { mountAuthorize } from "../src/oauth/mountOAuth.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
  InMemoryKv,
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";
import type { Auth } from "../src/auth/createAuth.js";

function harness(authOverride?: Partial<Auth>) {
  const auth: Auth = { ...stubAuth, ...authOverride };
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
  return { app, auth };
}

describe("mountServerEndpoints: /api/auth/* surface", () => {
  it("GET /api/auth/methods returns the registered methods, not the catch-all", async () => {
    const handlerCalls: Request[] = [];
    const { app } = harness({
      methods: [
        { kind: "social", provider: "github" },
        { kind: "magic-link" },
      ],
      handler: async (req) => {
        handlerCalls.push(req);
        return new Response("from-better-auth", { status: 418 });
      },
    });
    const res = await app.request("/api/auth/methods");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      methods: [
        { kind: "social", provider: "github" },
        { kind: "magic-link" },
      ],
    });
    expect(handlerCalls).toHaveLength(0);
  });

  it("GET /api/auth/<other> falls through to auth.handler via the SDK-mounted catch-all", async () => {
    const handlerCalls: Request[] = [];
    const { app } = harness({
      handler: async (req) => {
        handlerCalls.push(req);
        return new Response("ok-from-better-auth", { status: 200 });
      },
    });
    const res = await app.request("/api/auth/sign-in/social");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok-from-better-auth");
    expect(handlerCalls).toHaveLength(1);
  });

  it("mounts methods and catch-all under a custom auth base path", async () => {
    const handlerCalls: Request[] = [];
    const { app } = harness({
      basePath: "/api/platform/auth",
      methods: [{ kind: "social", provider: "github" }],
      handler: async (req) => {
        handlerCalls.push(req);
        return new Response("ok-from-platform-auth", { status: 200 });
      },
    });

    const methods = await app.request("/api/platform/auth/methods");
    expect(methods.status).toBe(200);
    expect(await methods.json()).toEqual({
      methods: [{ kind: "social", provider: "github" }],
    });

    const res = await app.request("/api/platform/auth/sign-in/social");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok-from-platform-auth");
    expect(handlerCalls).toHaveLength(1);
  });
});

describe("mountAuthorize", () => {
  it("redirects anonymous OAuth clients to the admin sign-in return parameter", async () => {
    const app = new Hono();
    mountAuthorize(app, { auth: stubAuth });

    const res = await app.request(
      "https://example.test/oauth/authorize?client_id=claude&redirect_uri=claude%3A%2F%2Fcallback&response_type=code&state=s&code_challenge=c&code_challenge_method=S256&scope=mcp",
      {},
      { OAUTH_PROVIDER: {} },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("/admin/sign-in?return=");
    expect(location).not.toContain("return_to=");

    const redirected = new URL(location!, "https://example.test");
    expect(redirected.searchParams.get("return")).toBe(
      "/oauth/authorize?client_id=claude&redirect_uri=claude%3A%2F%2Fcallback&response_type=code&state=s&code_challenge=c&code_challenge_method=S256&scope=mcp",
    );
  });
});
