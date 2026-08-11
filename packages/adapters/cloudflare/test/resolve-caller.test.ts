import { describe, expect, it } from "vitest";
import type { Auth } from "../src/auth/createAuth.js";
import { resolveCaller } from "../src/mount/resolveCaller.js";
import { stubAuth } from "./fakes/runtime-bindings.js";

function auth(overrides: Partial<Auth> = {}): Auth {
  return { ...stubAuth, ...overrides };
}

describe("resolveCaller", () => {
  it("returns an anonymous context when no credential or session exists", async () => {
    const result = await resolveCaller(new Request("https://example.test/api/x"), {
      auth: auth(),
    });
    expect(result).toMatchObject({
      kind: "anonymous",
      context: { user: null, staff: null },
    });
  });

  it("normalizes a cookie session without re-reading its staff role", async () => {
    let roleCalls = 0;
    const result = await resolveCaller(new Request("https://example.test/api/x", {
      headers: { cookie: "better-auth.session_token=session-1" },
    }), {
      auth: auth({
        getSession: async () => ({
          session: { id: "session-1", userId: "user-1", expiresAt: new Date() },
          user: { id: "user-1", email: "u@example.test", name: "U", role: "editor" },
        }),
        getUserRole: async () => {
          roleCalls += 1;
          return "editor";
        },
      }),
    });
    expect(result).toMatchObject({
      kind: "authenticated",
      context: {
        user: { id: "user-1" },
        staff: { id: "user-1", role: "editor" },
        auth: {
          credential: "session",
          credentialId: "session-1",
          scopes: [],
        },
      },
    });
    expect(roleCalls).toBe(0);
  });

  it("reads the live role when a custom session omits it", async () => {
    let roleCalls = 0;
    const result = await resolveCaller(new Request("https://example.test/api/x"), {
      auth: auth({
        getSession: async () => ({
          session: { id: "session-1", userId: "user-1", expiresAt: new Date() },
          user: { id: "user-1", email: "u@example.test", name: "U" },
        }),
        getUserRole: async () => {
          roleCalls += 1;
          return "owner";
        },
      }),
    });
    expect(result).toMatchObject({
      kind: "authenticated",
      context: { staff: { id: "user-1", role: "owner" } },
    });
    expect(roleCalls).toBe(1);
  });

  it("normalizes service API keys and user personal tokens without Core storage", async () => {
    const apiKey = await resolveCaller(
      new Request("https://example.test/api/x", { headers: { "x-api-key": "raw" } }),
      {
        auth: auth(),
        credentialResolver: () => ({
          kind: "verified",
          credential: {
            credential: "api-key",
            credentialId: "key-row-1",
            userId: null,
            scopes: ["orders:read"],
          },
        }),
      },
    );
    expect(apiKey).toMatchObject({
      kind: "authenticated",
      context: {
        user: null,
        auth: { credential: "api-key", credentialId: "key-row-1" },
      },
    });

    const personal = await resolveCaller(
      new Request("https://example.test/api/x", {
        headers: { authorization: "Bearer site_pat_raw" },
      }),
      {
        auth: auth({ getUserRole: async () => "owner" }),
        credentialResolver: () => ({
          kind: "verified",
          credential: {
            credential: "personal-token",
            credentialId: "pat-row-1",
            userId: "user-1",
            scopes: ["orders:read"],
          },
        }),
      },
    );
    expect(personal).toMatchObject({
      kind: "authenticated",
      context: {
        user: { id: "user-1" },
        staff: { id: "user-1", role: "owner" },
        auth: {
          credential: "personal-token",
          credentialId: "pat-row-1",
          scopes: ["orders:read"],
        },
      },
    });
  });

  it("never falls back to a valid cookie after a recognized invalid credential", async () => {
    let sessionCalls = 0;
    const result = await resolveCaller(
      new Request("https://example.test/api/x", {
        headers: { "x-api-key": "revoked", cookie: "valid=session" },
      }),
      {
        auth: auth({
          getSession: async () => {
            sessionCalls++;
            return null;
          },
        }),
        credentialResolver: () => ({ kind: "invalid" }),
      },
    );
    expect(result).toMatchObject({ kind: "invalid", status: 401 });
    expect(sessionCalls).toBe(0);
  });

  it("normalizes a configured OAuth bearer and preserves 401/403", async () => {
    const request = new Request("https://example.test/api/x", {
      headers: { authorization: "Bearer ey.header.signature" },
    });
    const allowed = await resolveCaller(request, {
      auth: auth({
        verifyOAuthAccessToken: async () => ({
          ok: true,
          userId: "user-1",
          clientId: "client-1",
          credentialId: "jti-1",
          scopes: ["orders:read"],
        }),
      }),
      oauthBearer: { audience: "https://api.example.test" },
    });
    expect(allowed).toMatchObject({
      kind: "authenticated",
      context: {
        auth: {
          credential: "oauth",
          clientId: "client-1",
          scopes: ["orders:read"],
        },
      },
    });

    const denied = await resolveCaller(request, {
      auth: auth({
        verifyOAuthAccessToken: async () => ({
          ok: false,
          status: 403,
          reason: "insufficient-scope",
          missingScopes: ["admin"],
        }),
      }),
      oauthBearer: { audience: "https://api.example.test", scopes: ["admin"] },
    });
    expect(denied).toMatchObject({
      kind: "invalid",
      status: 403,
      diagnostic: { code: "AUTH_DENIED" },
    });
  });

  it("normalizes the site's opaque OAuth bearer on manifest HTTP routes", async () => {
    const unwrapToken = async (token: string) => token === "user-1:grant-1:secret"
      ? {
          id: "token-1",
          grantId: "grant-1",
          userId: "user-1",
          createdAt: 1,
          expiresAt: 2,
          audience: "https://example.test/api",
          scope: ["mcp"],
          grant: { clientId: "client-1", scope: ["mcp"], props: {} },
        }
      : null;
    const options = {
      auth: auth({ getUserRole: async () => "viewer" }),
      env: { OAUTH_PROVIDER: { unwrapToken } },
    };

    const allowed = await resolveCaller(new Request("https://example.test/api/orders", {
      headers: { authorization: "Bearer user-1:grant-1:secret" },
    }), options);
    expect(allowed).toMatchObject({
      kind: "authenticated",
      context: {
        user: { id: "user-1" },
        staff: null,
        auth: {
          credential: "oauth",
          credentialId: "token-1",
          clientId: "client-1",
          scopes: ["mcp"],
        },
      },
    });

    const wrongAudience = await resolveCaller(new Request("https://other.test/api/orders", {
      headers: { authorization: "Bearer user-1:grant-1:secret" },
    }), options);
    expect(wrongAudience).toMatchObject({ kind: "invalid", status: 401 });
  });
});
