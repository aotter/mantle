import { compileTestPlan } from "./compileTestPlan.js";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMantleRuntimeRef } from "../src/mount/bootRuntimeOnce.js";
import { mountTestEndpoints } from "./mountTestEndpoints.js";
import { renderConsentHtml } from "../src/oauth/consentHtml.js";
import { mountAuthorize } from "../src/oauth/mountOAuth.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";
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
  it("renders consent with the shared admin system tokens", () => {
    const html = renderConsentHtml("en", null, "test-nonce");

    expect(html).toContain("--mantle-blue-deep");
    expect(html).toContain("background:var(--app-background)");
    expect(html).toContain("button:focus-visible");
    expect(html).not.toContain("--navy:");
  });

  it("renders the secret-free Better Auth consent projection", async () => {
    const app = new Hono();
    mountAuthorize(app, {
      auth: {
        ...stubAuth,
        getOAuthConsentRequest: async () => ({
          clientName: "Claude",
          redirectUri: "https://client.example/callback",
          scopes: ["mcp"],
          oauthQuery: "signed=query",
        }),
      },
    });

    const res = await app.request(
      "https://example.test/oauth/consent?client_id=claude&scope=mcp",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    const html = await res.text();
    expect(html).toContain("Claude");
    expect(html).toMatch(/<script nonce="[^"]+">/u);
  });

  it("locks both consent actions while preserving the submitted decision", () => {
    const html = renderConsentHtml("zh-TW", {
      clientName: "Claude",
      redirectUri: "https://client.example/callback",
      scopes: ["mcp"],
      oauthQuery: "signed=query",
    }, "test-nonce");

    expect(html).toContain('<input type="hidden" name="decision"/>');
    expect(html).toContain('data-loading-label="授權中…"');
    expect(html).toContain('data-loading-label="拒絕中…"');
    expect(html).toContain('this.setAttribute("aria-busy","true")');
    expect(html).toContain('action.disabled=true');
    expect(html).toContain('<script nonce="test-nonce">');
  });

  describe("consent POST CSRF defense (#389)", () => {
    const sessionAuth: Auth = {
      ...stubAuth,
      getSession: async () => ({
        session: { id: "s1", userId: "u1", expiresAt: new Date(Date.now() + 60_000) },
        user: { id: "u1", email: "u1@example.test", name: "U", role: "owner" },
      }),
      completeOAuthConsent: async () => {
        throw new Error("invalid authorization request");
      },
    } as Auth;

    function consentApp() {
      const app = new Hono();
      mountAuthorize(app, { auth: sessionAuth });
      return app;
    }

    async function post(headers: Record<string, string>): Promise<Response> {
      return consentApp().request(
        "https://example.test/oauth/consent",
        { method: "POST", headers, body: new URLSearchParams({ decision: "approve" }) },
      );
    }

    it("rejects a cross-site Sec-Fetch-Site POST with 403", async () => {
      const res = await post({ "sec-fetch-site": "cross-site" });
      expect(res.status).toBe(403);
    });

    it("rejects an Origin-mismatch POST with 403", async () => {
      const res = await post({ origin: "https://evil.test" });
      expect(res.status).toBe(403);
    });

    it("lets a same-origin POST past the CSRF guard", async () => {
      const res = await post({ "sec-fetch-site": "same-origin" });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("invalid authorization request");
    });
  });
});
