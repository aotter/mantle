import { describe, expect, it } from "vitest";
import {
  createConventionalAuth,
  setupIncompleteAuthResponse,
  type ConventionalAuthEnv,
} from "../src/auth/conventionalAuth.js";
import { createSetupIncompleteAuth } from "../src/auth/createAuth.js";

function fakeDb(): D1Database {
  const statement = {
    bind: () => statement,
    all: async () => ({ results: [], success: true, meta: {} }),
  };
  return {
    prepare: () => statement,
    exec: async () => ({ count: 0, duration: 0 }),
    batch: async () => [],
  } as unknown as D1Database;
}

async function expectSetupIncomplete(
  env: Omit<ConventionalAuthEnv, "DB">,
  message: string,
): Promise<void> {
  const auth = createConventionalAuth({ DB: fakeDb(), ...env });
  expect(auth.methods).toEqual([]);
  expect(await (await auth.handler(new Request("https://site.test/admin"))).json()).toEqual({
    error: "setup_incomplete",
    message,
  });
}

describe("conventional Auth", () => {
  it("keeps public routes available while private surfaces fail closed", async () => {
    const auth = createConventionalAuth({ DB: fakeDb() });

    expect(await setupIncompleteAuthResponse(new Request("https://site.test/"), auth)).toBeNull();
    for (const path of [
      "/admin",
      "/api/auth/methods",
      "/oauth/authorize",
      "/.well-known/oauth-authorization-server",
      "/mcp/staff",
    ]) {
      const response = await setupIncompleteAuthResponse(
        new Request(`https://site.test${path}`),
        auth,
      );
      expect(response?.status, path).toBe(503);
      expect(response?.headers.get("cache-control"), path).toBe("private, no-store");
    }
  });

  it("selects self-managed GitHub auth only when its mode is complete", () => {
    const auth = createConventionalAuth({
      DB: fakeDb(),
      MANTLE_AUTH_MODE: "self-managed",
      BETTER_AUTH_SECRET: "x".repeat(40),
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
      ADMIN_GITHUB_LOGIN: "owner",
    });

    expect(auth.methods).toEqual([{ kind: "social", provider: "github" }]);
  });

  it("selects a same-origin hosted PKCE client", () => {
    const auth = createConventionalAuth({
      DB: fakeDb(),
      PUBLIC_ORIGIN: "https://shop.test/",
      MANTLE_AUTH_MODE: "hosted",
      BETTER_AUTH_SECRET: "x".repeat(40),
      MANTLE_HOSTED_AUTH_ISSUER: "https://auth.mantle.tools",
      MANTLE_HOSTED_AUTH_CLIENT_ID: "https://auth.mantle.tools/clients/shop_1",
      ADMIN_GITHUB_LOGIN: "owner",
    });

    expect(auth.methods).toEqual([{
      kind: "oauth",
      providerId: "github",
      displayName: "GitHub",
    }]);
  });

  it("requires an explicit mode and rejects mixed provider credentials", async () => {
    await expectSetupIncomplete({
      BETTER_AUTH_SECRET: "x".repeat(40),
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
      ADMIN_GITHUB_LOGIN: "owner",
    }, "MANTLE_AUTH_MODE must be hosted or self-managed.");

    await expectSetupIncomplete({
      MANTLE_AUTH_MODE: "hosted",
      BETTER_AUTH_SECRET: "x".repeat(40),
      MANTLE_HOSTED_AUTH_ISSUER: "https://auth.mantle.tools",
      MANTLE_HOSTED_AUTH_CLIENT_ID: "https://auth.mantle.tools/clients/shop_1",
      GITHUB_CLIENT_ID: "conflict",
      ADMIN_GITHUB_LOGIN: "owner",
    }, "Hosted Auth is incomplete or conflicts with self-managed GitHub credentials.");

    await expectSetupIncomplete({
      MANTLE_AUTH_MODE: "self-managed",
      BETTER_AUTH_SECRET: "x".repeat(40),
      MANTLE_HOSTED_AUTH_ISSUER: "https://auth.mantle.tools",
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
      ADMIN_GITHUB_LOGIN: "owner",
    }, "Self-managed Auth is incomplete or conflicts with Hosted Auth configuration.");
  });

  it.each([
    ["an insecure remote issuer", "http://auth.example.com", "http://auth.example.com/clients/shop"],
    ["an issuer path", "https://auth.example.com/nested", "https://auth.example.com/clients/shop"],
    ["a cross-origin client", "https://auth.example.com", "https://other.example.com/clients/shop"],
    ["a client outside /clients/<id>", "https://auth.example.com", "https://auth.example.com/client/shop"],
    ["client query parameters", "https://auth.example.com", "https://auth.example.com/clients/shop?x=1"],
  ])("rejects hosted Auth with %s", async (_case, issuer, clientId) => {
    await expectSetupIncomplete({
      MANTLE_AUTH_MODE: "hosted",
      BETTER_AUTH_SECRET: "x".repeat(40),
      MANTLE_HOSTED_AUTH_ISSUER: issuer,
      MANTLE_HOSTED_AUTH_CLIENT_ID: clientId,
      ADMIN_GITHUB_LOGIN: "owner",
    }, "Hosted Auth is incomplete or conflicts with self-managed GitHub credentials.");
  });

  it("rejects an invalid bootstrap GitHub login", async () => {
    await expectSetupIncomplete({
      MANTLE_AUTH_MODE: "self-managed",
      BETTER_AUTH_SECRET: "x".repeat(40),
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
      ADMIN_GITHUB_LOGIN: "-owner",
    }, "Self-managed Auth is incomplete or conflicts with Hosted Auth configuration.");
  });

  it("removes CDN overrides from custom setup responses", async () => {
    const auth = createSetupIncompleteAuth({
      response: () => new Response("pending", {
        status: 503,
        headers: {
          "cdn-cache-control": "public, s-maxage=3600",
          "cloudflare-cdn-cache-control": "public, s-maxage=3600",
        },
      }),
    });

    const response = await setupIncompleteAuthResponse(
      new Request("https://site.test/admin"),
      auth,
    );
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("cdn-cache-control")).toBeNull();
    expect(response?.headers.get("cloudflare-cdn-cache-control")).toBeNull();
  });
});
