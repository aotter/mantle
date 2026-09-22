import { describe, expect, it, vi } from "vitest";
import type { DatabaseDriver } from "@aotter/mantle-runtime";
import {
  buildGenericOAuthProviders,
  buildSocialProviders,
  createMantleAuth,
  createSetupIncompleteAuth,
  normalizeAuthBasePath,
  resolveClientIpHeaders,
  type AuthMethodConfig,
  type CreateMantleAuthOptions,
} from "../src/createMantleAuth.js";

const GITHUB_METHOD = {
  kind: "social",
  provider: "github",
  options: { clientId: "g", clientSecret: "g" },
} as const satisfies AuthMethodConfig;

function fakeBetterAuthDatabase() {
  let id: unknown;
  const stmt = {
    bind: (...args: unknown[]) => {
      id = args[0];
      return stmt;
    },
    first: async () =>
      typeof id === "string" && id.startsWith("auth-schema:") ? { id } : null,
    all: async () => ({ results: [], success: true, meta: {} }),
  };
  return {
    prepare: () => stmt,
    exec: async () => ({ count: 0, duration: 0 }),
    batch: async () => [],
  };
}

function fakeDriver(): DatabaseDriver {
  const stmt = {
    bind: () => stmt,
    first: async () => ({ id: "auth-schema:1" }),
    all: async () => [],
    run: async () => ({ success: true, meta: { changes: 0 } }),
  };
  return {
    prepare: () => stmt,
    batch: async () => [],
    migrations: { runAll: async () => undefined },
  };
}

function baseOptions(
  overrides: Partial<CreateMantleAuthOptions> = {},
): CreateMantleAuthOptions {
  return {
    database: fakeBetterAuthDatabase() as CreateMantleAuthOptions["database"],
    driver: fakeDriver(),
    ipAddressHeaders: ["x-real-ip"],
    baseURL: "https://example.test",
    secret: "x".repeat(40),
    methods: [GITHUB_METHOD],
    ...overrides,
  };
}

describe("resolveClientIpHeaders", () => {
  it("fails closed when headers are missing or blank", () => {
    expect(() => resolveClientIpHeaders(undefined)).toThrow(
      /createMantleAuth:.*ipAddressHeaders/,
    );
    expect(() => resolveClientIpHeaders([])).toThrow(
      /createMantleAuth:.*ipAddressHeaders/,
    );
    expect(() => resolveClientIpHeaders(["", "  "])).toThrow(
      /createMantleAuth:.*ipAddressHeaders/,
    );
  });

  it("keeps trimmed host-supplied headers", () => {
    expect(resolveClientIpHeaders([" x-real-ip ", "x-vercel-forwarded-for"])).toEqual([
      "x-real-ip",
      "x-vercel-forwarded-for",
    ]);
  });
});

describe("createMantleAuth — IP identity", () => {
  it("refuses to boot without a trusted ingress header", () => {
    expect(() => createMantleAuth(baseOptions({ ipAddressHeaders: [] }))).toThrow(
      /createMantleAuth:.*ipAddressHeaders/,
    );
  });

  it("accepts a non-Cloudflare host header and boots", () => {
    const auth = createMantleAuth(baseOptions({ ipAddressHeaders: ["x-real-ip"] }));
    expect(auth.basePath).toBe("/api/auth");
  });
});

describe("normalizeAuthBasePath", () => {
  it("defaults empty or missing paths", () => {
    expect(normalizeAuthBasePath(undefined)).toBe("/api/auth");
    expect(normalizeAuthBasePath("")).toBe("/api/auth");
    expect(normalizeAuthBasePath("   ")).toBe("/api/auth");
  });

  it("rejects a missing leading slash and a root path", () => {
    expect(() => normalizeAuthBasePath("api/auth")).toThrow(
      /createMantleAuth:.*start with/,
    );
    expect(() => normalizeAuthBasePath("/")).toThrow(/createMantleAuth:.*not be/);
  });

  it("strips a trailing slash", () => {
    expect(normalizeAuthBasePath("/auth/")).toBe("/auth");
    expect(createSetupIncompleteAuth({ basePath: "/staff-auth/" }).basePath).toBe(
      "/staff-auth",
    );
  });
});

describe("provider conflict helpers", () => {
  it("rejects a duplicate social provider", () => {
    expect(() =>
      buildSocialProviders([GITHUB_METHOD, { ...GITHUB_METHOD }]),
    ).toThrow(/createMantleAuth:.*github.*more than once/i);
  });

  it("rejects an OAuth providerId that collides with a social provider", () => {
    expect(() =>
      buildGenericOAuthProviders([
        GITHUB_METHOD,
        {
          kind: "oauth",
          options: {
            providerId: "github",
            clientId: "c",
            discoveryUrl: "https://idp.test/.well-known/openid-configuration",
          },
        },
      ]),
    ).toThrow(/createMantleAuth:.*conflicts with a registered social provider id/);
  });
});

describe("createMantleAuth — oauthProvider.extensions passthrough", () => {
  const GRANT = "urn:example:grant-type:test";
  function tokenRequest() {
    return new Request("https://example.test/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: GRANT, assertion: "opaque" }),
    });
  }
  const provider = {
    loginPage: "/admin/sign-in",
    consentPage: "/oauth/consent",
    scopes: ["mcp"],
  } as const;

  for (const mcpResource of [undefined, "https://example.test/mcp"]) {
    it(`dispatches an extension grant_type to the adopter's handler (mcpResource=${mcpResource ?? "none"})`, async () => {
      const grant = vi.fn(async () => ({
        access_token: "issued-by-extension",
        token_type: "Bearer" as const,
        expires_in: 60,
      }));
      const auth = createMantleAuth(
        baseOptions({
          oauthProvider: { ...provider, mcpResource, extensions: [{ grants: { [GRANT]: grant } }] },
        }),
      );
      const response = await auth.handler(tokenRequest());
      expect(grant).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ access_token: "issued-by-extension" });
    });
  }

  it("rejects an extension grant_type that no extension declared", async () => {
    const auth = createMantleAuth(baseOptions({ oauthProvider: provider }));
    const response = await auth.handler(tokenRequest());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" });
  });
});
