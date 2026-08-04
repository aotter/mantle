import { describe, expect, it } from "vitest";
import {
  createConventionalAuth,
  setupIncompleteAuthResponse,
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

  it("selects self-managed GitHub auth independently", () => {
    const auth = createConventionalAuth({
      DB: fakeDb(),
      BETTER_AUTH_SECRET: "x".repeat(40),
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
      ADMIN_GITHUB_LOGIN: "owner",
    });

    expect(auth.methods).toEqual([{ kind: "social", provider: "github" }]);
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
