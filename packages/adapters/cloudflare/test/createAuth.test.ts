import { describe, expect, it, vi } from "vitest";
import type { EmailSender } from "@aotter/mantle-runtime";
import {
  buildGenericOAuthProviders,
  buildOAuthResourceLifecyclePlugin,
  buildOAuthProviderOptions,
  buildSocialProviders,
  buildTrustedOriginsFor,
  createAuth,
  createSetupIncompleteAuth,
  decodeMemberCursor,
  getProviderAccessTokenForRequest,
  guardGithubLoginProfile,
  mapRegisteredOAuthClient,
  normalizeAuthResponseCookies,
  pickLocale,
  shouldPromoteToOwner,
  STAFF_ROLES,
  validateBootstrap,
  verifyOAuthJwt,
  verifyOAuthJwtWithLocalJwks,
  type AuthMethodConfig,
  type BootstrapOwnerRule,
  type CreateAuthConfig,
} from "../src/auth/createAuth.js";

/**
 * Unit tests for `createAuth`. Covers the pure helpers (pickLocale,
 * validateBootstrap, shouldPromoteToOwner, buildSocialProviders) and
 * the construction-time invariants `createAuth` enforces (empty
 * methods, bootstrap mismatch, singleton-per-method, reserved-keys
 * in social.extras).
 *
 * End-to-end Better Auth flows (sign-in / sign-up / session creation
 * / cookie issuance) need a real HTTP harness against D1 and are not
 * covered here — those land in a future integration smoke.
 */

const NULL_SENDER: EmailSender = {
  send: async () => {
    // no-op for tests
  },
};

const GITHUB_METHOD_FIXTURE = {
  kind: "social",
  provider: "github",
  clientId: "g",
  clientSecret: "g",
} as const satisfies AuthMethodConfig;

it("keeps every Better Auth Set-Cookie header on redirects", () => {
  const response = normalizeAuthResponseCookies(
    new Response(null, {
      status: 302,
      headers: {
        location: "https://example.test/return",
        "set-cookie":
          "__Secure-mantle.oauth_state=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/, __Secure-mantle.session_token=session.sig; Path=/; HttpOnly; Secure",
      },
    }),
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://example.test/return");
  expect(
    (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie(),
  ).toHaveLength(2);
});

it("verifies provider JWTs with the same auth instance's JWKS", async () => {
  const issuer = "https://platform.example.test/api/auth";
  const audience = "https://platform.example.test/api";
  const keyPair = await crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const encode = (value: string | Uint8Array) =>
    Buffer.from(value).toString("base64url");
  const header = encode(JSON.stringify({ alg: "EdDSA", kid: "local-key" }));
  const payload = encode(JSON.stringify({
    iss: issuer,
    aud: audience,
    sub: "owner-1",
    scope: "platform:sites:read",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
  }));
  const input = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      keyPair.privateKey,
      new TextEncoder().encode(input),
    ),
  );

  const claims = await verifyOAuthJwtWithLocalJwks(
    `${input}.${encode(signature)}`,
    audience,
    issuer,
    async () => ({
      keys: [{
        ...publicJwk,
        alg: "EdDSA",
        kid: "local-key",
      }],
    }),
  );

  expect(claims["sub"]).toBe("owner-1");
});

/**
 * `buildSocialProviders` returns `BetterAuthOptions["socialProviders"]`
 * — a union of per-provider option types under named keys. Tests assert
 * against arbitrary keys, so cast once at the boundary.
 */
function asProviderMap(
  out: ReturnType<typeof buildSocialProviders>,
): Record<string, Record<string, unknown>> {
  return out as unknown as Record<string, Record<string, unknown>>;
}

function fakeDb(): D1Database {
  // Better Auth probes the D1 binding during construction (its kysely
  // wrapper calls `.prepare(sql).bind(...).all()` to introspect). A
  // bare `{}` raises `BetterAuthError: Failed to initialize database
  // adapter` as an unhandled rejection. Tests that actually exercise
  // queries are out of scope here (would need miniflare).
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: [], success: true, meta: {} }),
  };
  return {
    prepare: () => stmt,
    exec: async () => ({ count: 0, duration: 0 }),
    batch: async () => [],
  } as unknown as D1Database;
}

function baseConfig(
  overrides: Partial<CreateAuthConfig> = {},
): CreateAuthConfig {
  return {
    database: fakeDb(),
    baseURL: "https://example.test",
    secret: "x".repeat(40),
    methods: [GITHUB_METHOD_FIXTURE],
    ...overrides,
  };
}

describe("pickLocale", () => {
  function req(headerValue: string | undefined): Request | undefined {
    if (headerValue === undefined) return undefined;
    return new Request("https://example.test/", {
      headers: { "accept-language": headerValue },
    });
  }

  it("returns fallback when request is undefined", () => {
    expect(pickLocale(undefined, "en")).toBe("en");
  });

  it("returns fallback when accept-language is missing", () => {
    expect(
      pickLocale(new Request("https://example.test/"), "ja"),
    ).toBe("ja");
  });

  it("returns the first tag with q-values stripped", () => {
    expect(
      pickLocale(req("en-US,en;q=0.9,zh-TW;q=0.8"), "en"),
    ).toBe("en-US");
  });

  it("trims surrounding whitespace", () => {
    expect(pickLocale(req("  fr-FR  "), "en")).toBe("fr-FR");
  });

  it("returns fallback when the first tag is empty after splitting", () => {
    // A header that's literally a leading comma — first split is ""
    expect(pickLocale(req(","), "en")).toBe("en");
  });

  it("does not interpret '*' specially — returns it as-is", () => {
    // '*' is the wildcard, but the v0.1 picker doesn't try to resolve
    // it. The receiving sender / template decides what to do.
    expect(pickLocale(req("*"), "en")).toBe("*");
  });
});

describe("validateBootstrap", () => {
  it("accepts match='github-login' when a social method with provider='github' is registered", () => {
    expect(() =>
      validateBootstrap(
        { match: "github-login", value: "alice" },
        [GITHUB_METHOD_FIXTURE],
      ),
    ).not.toThrow();
  });

  it("accepts match='github-login' for a trusted generic GitHub proxy", () => {
    expect(() =>
      validateBootstrap(
        { match: "github-login", value: "alice" },
        [{
          kind: "oauth",
          providerId: "github",
          clientId: "https://auth.example/clients/site-1",
          authorizationUrl: "https://auth.example/authorize",
          tokenUrl: "https://auth.example/token",
        }],
      ),
    ).not.toThrow();
  });

  it("throws when match='github-login' but no GitHub provider is registered", () => {
    expect(() =>
      validateBootstrap(
        { match: "github-login", value: "alice" },
        [
          {
            kind: "social",
            provider: "google",
            clientId: "x",
            clientSecret: "y",
          },
        ],
      ),
    ).toThrow(/github-login.*github/i);
  });

  it("accepts match='email' regardless of registered methods", () => {
    // Every Better Auth method populates user.email; no method-specific
    // constraint to enforce.
    expect(() =>
      validateBootstrap(
        { match: "email", value: "alice@example.com" },
        [{ kind: "email-otp", sender: NULL_SENDER }],
      ),
    ).not.toThrow();
    expect(() =>
      validateBootstrap(
        { match: "email", value: "alice@example.com" },
        [],
      ),
    ).not.toThrow();
  });
});

describe("shouldPromoteToOwner", () => {
  const ghRule: BootstrapOwnerRule = { match: "github-login", value: "alice" };
  const emailRule: BootstrapOwnerRule = {
    match: "email",
    value: "alice@example.com",
  };

  it("matches github-login when user.githubLogin equals rule value", () => {
    expect(shouldPromoteToOwner(ghRule, { githubLogin: "alice" })).toBe(true);
  });

  it("matches github-login case-insensitively", () => {
    expect(shouldPromoteToOwner(ghRule, { githubLogin: "Alice" })).toBe(true);
    expect(
      shouldPromoteToOwner({ ...ghRule, value: "ALICE" }, { githubLogin: "alice" }),
    ).toBe(true);
  });

  it("trims rule value before comparison", () => {
    expect(
      shouldPromoteToOwner(
        { match: "github-login", value: "  alice  " },
        { githubLogin: "alice" },
      ),
    ).toBe(true);
  });

  it("rejects github-login when user.githubLogin is missing", () => {
    expect(shouldPromoteToOwner(ghRule, {})).toBe(false);
    expect(shouldPromoteToOwner(ghRule, { githubLogin: null })).toBe(false);
    expect(shouldPromoteToOwner(ghRule, { email: "alice@example.com" })).toBe(
      false,
    );
  });

  it("matches email rule case-insensitively", () => {
    expect(
      shouldPromoteToOwner(emailRule, { email: "Alice@Example.com" }),
    ).toBe(true);
  });

  it("rejects email rule when user.email is missing", () => {
    expect(shouldPromoteToOwner(emailRule, {})).toBe(false);
    expect(shouldPromoteToOwner(emailRule, { email: null })).toBe(false);
  });

  it("rejects when user.githubLogin and email both miss the rule value", () => {
    expect(
      shouldPromoteToOwner(ghRule, { githubLogin: "bob", email: "bob@example.com" }),
    ).toBe(false);
    expect(
      shouldPromoteToOwner(emailRule, {
        githubLogin: "alice",
        email: "bob@example.com",
      }),
    ).toBe(false);
  });
});

describe("buildSocialProviders", () => {
  it("emits per-provider config keyed by provider id", () => {
    const out = asProviderMap(
      buildSocialProviders([
        { kind: "social", provider: "github", clientId: "g_id", clientSecret: "g_s" },
        { kind: "social", provider: "google", clientId: "o_id", clientSecret: "o_s" },
      ]),
    );
    expect(out.github?.clientId).toBe("g_id");
    expect(out.github?.clientSecret).toBe("g_s");
    expect(out.google?.clientId).toBe("o_id");
    expect(out.google?.clientSecret).toBe("o_s");
  });

  it("injects mapProfileToUser shim only for github", () => {
    const out = asProviderMap(
      buildSocialProviders([
        GITHUB_METHOD_FIXTURE,
        { kind: "social", provider: "google", clientId: "o", clientSecret: "o" },
      ]),
    );
    const ghMap = out.github?.mapProfileToUser as (p: {
      login?: string;
    }) => Record<string, unknown>;
    expect(typeof ghMap).toBe("function");
    expect(ghMap({ login: "alice" })).toEqual({ githubLogin: "alice" });
    expect(out.google?.mapProfileToUser).toBeUndefined();
  });

  it("merges extras into the provider config", () => {
    const out = asProviderMap(
      buildSocialProviders([
        {
          kind: "social",
          provider: "microsoft-entra-id",
          clientId: "m",
          clientSecret: "m",
          extras: { tenantId: "common", prompt: "select_account" },
        },
      ]),
    );
    expect(out["microsoft-entra-id"]?.tenantId).toBe("common");
    expect(out["microsoft-entra-id"]?.prompt).toBe("select_account");
  });

  it("defensively copies the scope array — caller mutation doesn't leak", () => {
    // `scope: [...method.scope]` in buildSocialProviders. Mutating
    // the caller-side array must not affect what Better Auth sees.
    const scopes = ["openid", "profile"];
    const out = asProviderMap(
      buildSocialProviders([
        {
          kind: "social",
          provider: "google",
          clientId: "g",
          clientSecret: "g",
          scope: scopes,
        },
      ]),
    );
    scopes.push("email");
    expect(out.google?.scope).toEqual(["openid", "profile"]);
  });

  it("includes redirectURI and scope only when set", () => {
    const out = asProviderMap(
      buildSocialProviders([
        {
          kind: "social",
          provider: "google",
          clientId: "g",
          clientSecret: "g",
          redirectURI: "https://example.test/cb",
          scope: ["openid", "profile", "email"],
        },
      ]),
    );
    expect(out.google?.redirectURI).toBe("https://example.test/cb");
    expect(out.google?.scope).toEqual(["openid", "profile", "email"]);
  });

  it.each([
    "clientId",
    "clientSecret",
    "redirectURI",
    "scope",
    "mapProfileToUser",
  ])("throws when extras contains reserved key '%s'", (reserved) => {
    expect(() =>
      buildSocialProviders([
        {
          kind: "social",
          provider: "google",
          clientId: "g",
          clientSecret: "g",
          extras: { [reserved]: "shadow" },
        },
      ]),
    ).toThrow(new RegExp(`reserved key.*${reserved}`));
  });

  it("ignores non-social methods", () => {
    const out = asProviderMap(
      buildSocialProviders([
        { kind: "email-otp", sender: NULL_SENDER },
        { kind: "magic-link", sender: NULL_SENDER },
      ]),
    );
    expect(Object.keys(out)).toHaveLength(0);
  });

  it("throws when the same social provider is registered twice", () => {
    // Without the guard, Better Auth would silently keep the second
    // entry (Record assignment overwrites). With overlay-driven
    // feature contributions joining a starter's `methods[]` array, a
    // duplicate is easy to introduce and very hard to debug from a
    // failing sign-in alone.
    expect(() =>
      buildSocialProviders([
        { kind: "social", provider: "github", clientId: "a", clientSecret: "a" },
        { kind: "social", provider: "github", clientId: "b", clientSecret: "b" },
      ]),
    ).toThrow(/'github'.*registered more than once/i);
  });

  it("throws for duplicate non-github providers too", () => {
    expect(() =>
      buildSocialProviders([
        { kind: "social", provider: "google", clientId: "a", clientSecret: "a" },
        { kind: "social", provider: "google", clientId: "b", clientSecret: "b" },
      ]),
    ).toThrow(/'google'.*registered more than once/i);
  });
});

describe("guardGithubLoginProfile", () => {
  it("accepts only registered provider callback profiles", () => {
    const hosted = {
      kind: "oauth",
      providerId: "github",
      clientId: "client",
      authorizationUrl: "https://auth.example/authorize",
      tokenUrl: "https://auth.example/token",
      mapProfileToUser: () => ({ githubLogin: "owner" }),
    } as const satisfies AuthMethodConfig;

    expect(guardGithubLoginProfile(
      { githubLogin: "owner" },
      { path: "/oauth2/callback/:providerId", params: { providerId: "github" } },
      [hosted],
    )).toBeUndefined();
    expect(guardGithubLoginProfile(
      { githubLogin: "owner" },
      { path: "/update-user", params: {} },
      [hosted],
    )).toEqual({ data: { githubLogin: null } });
    expect(guardGithubLoginProfile(
      { githubLogin: "owner" },
      { path: "/oauth2/callback/:providerId", params: { providerId: "other" } },
      [hosted],
    )).toEqual({ data: { githubLogin: null } });
  });

  it("accepts the built-in GitHub social callback", () => {
    expect(guardGithubLoginProfile(
      { githubLogin: "owner" },
      { path: "/callback/:id", params: { id: "github" } },
      [GITHUB_METHOD_FIXTURE],
    )).toBeUndefined();
  });
});

describe("buildGenericOAuthProviders", () => {
  it("emits Better Auth generic OAuth config and keeps displayName for the public method descriptor", () => {
    const out = buildGenericOAuthProviders([
      {
        kind: "oauth",
        providerId: "mantle-platform",
        displayName: "Mantle Platform",
        clientId: "client",
        clientSecret: "secret",
        discoveryUrl: "https://platform.mantle.tools/.well-known/openid-configuration",
        issuer: "https://platform.mantle.tools",
        requireIssuerValidation: true,
        scopes: ["openid", "profile", "email"],
        pkce: true,
      },
    ]);

    expect(out).toEqual([
      {
        providerId: "mantle-platform",
        displayName: "Mantle Platform",
        clientId: "client",
        clientSecret: "secret",
        discoveryUrl: "https://platform.mantle.tools/.well-known/openid-configuration",
        issuer: "https://platform.mantle.tools",
        requireIssuerValidation: true,
        scopes: ["openid", "profile", "email"],
        pkce: true,
      },
    ]);
  });

  it("throws when an oauth method has no discoveryUrl or endpoint pair", () => {
    expect(() =>
      buildGenericOAuthProviders([
        { kind: "oauth", providerId: "broken", clientId: "c" },
      ]),
    ).toThrow(/discoveryUrl.*authorizationUrl.*tokenUrl/i);
  });

  it("accepts a public PKCE OAuth client without a client secret", () => {
    const out = buildGenericOAuthProviders([
      {
        kind: "oauth",
        providerId: "public-client",
        clientId: "client",
        discoveryUrl: "https://platform.test/.well-known/openid-configuration",
        pkce: true,
      },
    ]);
    expect(out[0]).not.toHaveProperty("clientSecret");
    expect(out[0]).toMatchObject({ clientId: "client", pkce: true });
  });

  it("passes the validated profile mapper to Better Auth", async () => {
    const mapProfileToUser = (profile: Record<string, unknown>) => ({
      githubLogin: typeof profile.github_login === "string" ? profile.github_login : null,
    });
    const [provider] = buildGenericOAuthProviders([
      {
        kind: "oauth",
        providerId: "mantle-hosted-auth",
        clientId: "client",
        discoveryUrl: "https://auth.mantle.tools/.well-known/openid-configuration",
        mapProfileToUser,
      },
    ]);

    expect(provider?.mapProfileToUser).toBe(mapProfileToUser);
    expect(await provider?.mapProfileToUser?.({ github_login: "guyspy" })).toEqual({
      githubLogin: "guyspy",
    });
  });

  it("maps an RFC 8707 resource to authorization and token params", () => {
    const out = buildGenericOAuthProviders([
      {
        kind: "oauth",
        providerId: "platform",
        clientId: "client",
        authorizationUrl: "https://platform.test/authorize",
        tokenUrl: "https://platform.test/token",
        resource: "https://api.platform.test",
      },
    ]);
    expect(out[0]).toMatchObject({
      resource: "https://api.platform.test",
      authorizationUrlParams: { resource: "https://api.platform.test" },
      tokenUrlParams: { resource: "https://api.platform.test" },
    });
  });

  it("carries resource through authorization, code exchange, and refresh exchange", async () => {
    const bodies: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      let resource = "";
      if (init?.body instanceof URLSearchParams) {
        const body = new URLSearchParams(init.body);
        bodies.push(body);
        resource = body.get("resource") ?? "";
      }
      const payload = Buffer.from(JSON.stringify({ aud: resource })).toString(
        "base64url",
      );
      return Response.json({
        access_token: `header.${payload}.signature`,
        refresh_token: "refresh-2",
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
    try {
      const plugin = buildOAuthResourceLifecyclePlugin([
        {
          kind: "oauth",
          providerId: "platform",
          clientId: "client",
          authorizationUrl: "https://platform.test/authorize",
          tokenUrl: "https://platform.test/token",
          resource: "https://api.platform.test",
        },
      ]);
      expect(plugin).not.toBeNull();
      const initialized = await plugin!.init!({
        socialProviders: [
          {
            id: "platform",
            name: "platform",
            createAuthorizationURL: async () =>
              new URL("https://platform.test/authorize?client_id=client"),
            validateAuthorizationCode: async () => null,
            refreshAccessToken: async () => ({}),
            getUserInfo: async () => null,
          },
        ],
      } as never);
      const providers = (initialized as {
        context?: { socialProviders?: Array<Record<string, unknown>> };
      }).context?.socialProviders;
      const provider = providers?.[0] as {
        createAuthorizationURL(data: Record<string, unknown>): Promise<URL>;
        validateAuthorizationCode(data: {
          code: string;
          redirectURI: string;
          codeVerifier?: string;
        }): Promise<{ accessToken?: string } | null>;
        refreshAccessToken(token: string): Promise<{ accessToken?: string }>;
      };

      const authorization = await provider.createAuthorizationURL({});
      expect(authorization.searchParams.get("resource")).toBe(
        "https://api.platform.test",
      );
      const exchanged = await provider.validateAuthorizationCode({
        code: "code-1",
        redirectURI: "https://site.test/callback",
      });
      const refreshed = await provider.refreshAccessToken("refresh-1");
      expect(exchanged?.accessToken).toBeTruthy();
      expect(refreshed.accessToken).toBeTruthy();
      expect(bodies).toHaveLength(2);
      expect(bodies[0]?.get("grant_type")).toBe("authorization_code");
      expect(bodies[0]?.get("resource")).toBe("https://api.platform.test");
      expect(bodies[1]?.get("grant_type")).toBe("refresh_token");
      expect(bodies[1]?.get("resource")).toBe("https://api.platform.test");
      for (const token of [exchanged?.accessToken, refreshed.accessToken]) {
        expect(token?.split(".")).toHaveLength(3);
        const claims = JSON.parse(
          Buffer.from(token!.split(".")[1]!, "base64url").toString("utf8"),
        ) as { aud?: string };
        expect(claims.aud).toBe("https://api.platform.test");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws when the same oauth providerId is registered twice", () => {
    expect(() =>
      buildGenericOAuthProviders([
        {
          kind: "oauth",
          providerId: "mantle-platform",
          clientId: "a",
          discoveryUrl: "https://platform.mantle.tools/.well-known/openid-configuration",
        },
        {
          kind: "oauth",
          providerId: "mantle-platform",
          clientId: "b",
          discoveryUrl: "https://platform.mantle.tools/.well-known/openid-configuration",
        },
      ]),
    ).toThrow(/mantle-platform.*registered more than once/i);
  });

  it("rejects an oauth providerId that collides with a social provider", () => {
    expect(() =>
      buildGenericOAuthProviders([
        {
          kind: "social",
          provider: "github",
          clientId: "social-client",
          clientSecret: "social-secret",
        },
        {
          kind: "oauth",
          providerId: "github",
          clientId: "oauth-client",
          discoveryUrl: "https://issuer.test/.well-known/openid-configuration",
          resource: "https://api.test",
        },
      ]),
    ).toThrow(/conflicts with a registered social provider id/i);
  });
});

describe("verifyOAuthJwt facade", () => {
  it("rejects opaque tokens before invoking the JWKS verifier", async () => {
    const verify = vi.fn(async () => ({ sub: "user-1" }));
    await expect(
      verifyOAuthJwt("opaque-token", { audience: "https://api.test" }, verify),
    ).resolves.toEqual({ ok: false, status: 401, reason: "invalid-token" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("returns only normalized caller claims after successful verification", async () => {
    const result = await verifyOAuthJwt(
      "header.payload.signature",
      { audience: "https://api.test", scopes: ["orders:read"] },
      async (_token, audience) => {
        expect(audience).toBe("https://api.test");
        return {
          sub: "user-1",
          azp: "client-1",
          jti: "token-1",
          scope: "openid orders:read",
          unrelated_secret_claim: "must-not-escape",
        };
      },
    );
    expect(result).toEqual({
      ok: true,
      userId: "user-1",
      clientId: "client-1",
      credentialId: "token-1",
      scopes: ["openid", "orders:read"],
    });
  });

  it("returns 403 only after a verified JWT lacks a required scope", async () => {
    const result = await verifyOAuthJwt(
      "header.payload.signature",
      { audience: "https://api.test", scopes: ["orders:write"] },
      async () => ({ sub: "user-1", scope: "orders:read" }),
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: "insufficient-scope",
      missingScopes: ["orders:write"],
    });
  });

  it.each(["issuer", "audience", "signature", "expiry", "not-before"])(
    "fails closed with 401 when the underlying verifier rejects %s",
    async () => {
      const result = await verifyOAuthJwt(
        "header.payload.signature",
        { audience: "https://api.test" },
        async () => {
          throw new Error("verification failed");
        },
      );
      expect(result).toEqual({ ok: false, status: 401, reason: "invalid-token" });
    },
  );

  it("rejects a verified JWT without a subject", async () => {
    const result = await verifyOAuthJwt(
      "header.payload.signature",
      { audience: "https://api.test" },
      async () => ({ scope: "mcp" }),
    );
    expect(result).toEqual({ ok: false, status: 401, reason: "invalid-token" });
  });
});

describe("getProviderAccessTokenForRequest", () => {
  it("binds lookup/refresh to the current session request and omits refresh-token data", async () => {
    const request = new Request("https://site.test/server/action", {
      headers: { cookie: "session=current-user" },
    });
    const getAccessToken = vi.fn(async () => ({
      accessToken: "access-1",
      accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      scopes: ["orders:read"],
      refreshToken: "must-not-escape",
      account: { id: "must-not-escape" },
    }));
    const value = await getProviderAccessTokenForRequest(
      { getAccessToken },
      request,
      "platform",
    );
    expect(getAccessToken).toHaveBeenCalledWith({
      headers: request.headers,
      body: { providerId: "platform" },
    });
    expect(value).toEqual({
      accessToken: "access-1",
      accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      scopes: ["orders:read"],
    });
    expect(value).not.toHaveProperty("refreshToken");
  });
});

describe("buildOAuthProviderOptions", () => {
  it("maps and defensively copies explicit valid JWT audiences", () => {
    const validAudiences = ["https://api.example.test"];
    const options = buildOAuthProviderOptions({
      loginPage: "/sign-in",
      consentPage: "/consent",
      scopes: ["openid", "orders:read"],
      validAudiences,
    });
    validAudiences.push("https://mutated.example.test");
    expect(options.validAudiences).toEqual(["https://api.example.test"]);
    expect(options.scopes).toEqual(["openid", "orders:read"]);
  });
});

describe("registered OAuth client mapping", () => {
  it("never returns a public client's secret even if the provider includes one", () => {
    const client = mapRegisteredOAuthClient({
      client_id: "public-client",
      client_secret: "must-not-escape",
      redirect_uris: ["https://site.test/callback"],
      token_endpoint_auth_method: "none",
      public: true,
    });
    expect(client).not.toHaveProperty("clientSecret");
    expect(client).toMatchObject({ clientId: "public-client", public: true });
  });
});

describe("createAuth — boot invariants", () => {
  it("throws when methods[] is empty", () => {
    expect(() => createAuth(baseConfig({ methods: [] }))).toThrow(/empty/i);
  });

  it("offers a setup-incomplete facade for first-deploy public boot", async () => {
    const auth = createSetupIncompleteAuth({
      message: "setup pending",
      response: () => new Response("setup pending", { status: 503 }),
    });
    const req = new Request("https://example.test/admin/sign-in");

    expect(auth.basePath).toBe("/api/auth");
    expect(auth.methods).toEqual([]);
    expect(await auth.getSession(req)).toBeNull();
    expect(await auth.getUserRole("user_1")).toBeNull();
    expect(await auth.getUser?.("user_1")).toBeNull();
    expect(await auth.handler(req)).toMatchObject({ status: 503 });
    expect(await auth.listLinkedAccounts("user_1")).toEqual([]);
    expect(await auth.unlinkAccount("user_1", "github")).toBe(false);
    expect(await auth.listUsers()).toEqual([]);
    expect(await auth.setUserRole("user_1", "editor")).toBe(false);
    await expect(auth.inviteUser("owner@example.test", "owner")).rejects.toThrow(
      /setup pending/,
    );
    expect(await auth.revokeInvite("user_1")).toBe(false);
    await expect(
      auth.registerOAuthClient({
        requestHeaders: new Headers(),
        redirectUris: ["https://site.test/api/auth/callback"],
      }),
    ).rejects.toThrow(/setup pending/);
  });

  it("throws when bootstrapOwner.match='github-login' but no github method", () => {
    expect(() =>
      createAuth(
        baseConfig({
          methods: [{ kind: "email-otp", sender: NULL_SENDER }],
          bootstrapOwner: { match: "github-login", value: "alice" },
        }),
      ),
    ).toThrow(/github-login.*github/i);
  });

  it("throws when more than one email-otp method is registered", () => {
    expect(() =>
      createAuth(
        baseConfig({
          methods: [
            { kind: "email-otp", sender: NULL_SENDER },
            { kind: "email-otp", sender: NULL_SENDER },
          ],
        }),
      ),
    ).toThrow(/email-otp/i);
  });

  it("throws when more than one magic-link method is registered", () => {
    expect(() =>
      createAuth(
        baseConfig({
          methods: [
            { kind: "magic-link", sender: NULL_SENDER },
            { kind: "magic-link", sender: NULL_SENDER },
          ],
        }),
      ),
    ).toThrow(/magic-link/i);
  });

  it("throws when social.extras contains a reserved key", () => {
    expect(() =>
      createAuth(
        baseConfig({
          methods: [
            {
              kind: "social",
              provider: "google",
              clientId: "g",
              clientSecret: "g",
              extras: { clientSecret: "shadow" },
            },
          ],
        }),
      ),
    ).toThrow(/reserved key.*clientSecret/);
  });

  it("returns Auth.methods reflecting the registered methods, in declaration order", () => {
    const auth = createAuth(
      baseConfig({
        methods: [
          GITHUB_METHOD_FIXTURE,
          { kind: "email-otp", sender: NULL_SENDER },
          { kind: "magic-link", sender: NULL_SENDER },
          {
            kind: "social",
            provider: "google",
            clientId: "o",
            clientSecret: "o",
          },
          {
            kind: "oauth",
            providerId: "mantle-platform",
            displayName: "Mantle Platform",
            clientId: "platform-client",
            clientSecret: "platform-secret",
            discoveryUrl: "https://platform.mantle.tools/.well-known/openid-configuration",
          },
        ],
        bootstrapOwner: { match: "email", value: "alice@example.com" },
      }),
    );
    expect(auth.methods).toEqual([
      { kind: "social", provider: "github" },
      { kind: "email-otp" },
      { kind: "magic-link" },
      { kind: "social", provider: "google" },
      {
        kind: "oauth",
        providerId: "mantle-platform",
        displayName: "Mantle Platform",
      },
    ]);
  });

  it("returns an Auth surface with handler / getSession / user lookup", () => {
    const auth = createAuth(baseConfig());
    expect(auth.basePath).toBe("/api/auth");
    expect(typeof auth.handler).toBe("function");
    expect(typeof auth.getSession).toBe("function");
    expect(typeof auth.getUserRole).toBe("function");
    expect(typeof auth.getUser).toBe("function");
    expect(typeof auth.registerOAuthClient).toBe("function");
  });

  it("accepts a custom Better Auth base path", () => {
    const auth = createAuth(
      baseConfig({
        basePath: "/api/platform/auth",
      }),
    );
    expect(auth.basePath).toBe("/api/platform/auth");
  });

  it("rejects an auth base path without a leading slash", () => {
    expect(() =>
      createAuth(
        baseConfig({
          basePath: "api/platform/auth",
        }),
      ),
    ).toThrow(/basePath.*start with/i);
  });

  it("rejects the root auth base path", () => {
    expect(() =>
      createAuth(
        baseConfig({
          basePath: "/",
        }),
      ),
    ).toThrow(/basePath.*not be/i);
  });

  it("constructs an OAuth/OIDC provider when oauthProvider is configured", () => {
    const auth = createAuth(
      baseConfig({
        oauthProvider: {
          loginPage: "/admin/sign-in",
          consentPage: "/oauth/consent",
          scopes: ["openid", "profile", "email"],
        },
      }),
    );
    expect(typeof auth.registerOAuthClient).toBe("function");
  });

  it("registers apple → constructs without throwing (auto-trustedOrigins ride internally)", () => {
    // We can't easily inspect the Better Auth instance's internal
    // `trustedOrigins` from outside (no public read-API), so the
    // unit test asserts the construction path doesn't throw and the
    // `Auth.methods` reflects the registration. A future integration
    // test against /api/auth/sign-in/social with provider=apple
    // would close the trustedOrigins claim end-to-end.
    const auth = createAuth(
      baseConfig({
        methods: [
          {
            kind: "social",
            provider: "apple",
            clientId: "com.example.web",
            clientSecret: "JWT-placeholder",
          },
        ],
        bootstrapOwner: { match: "email", value: "owner@example.com" },
      }),
    );
    expect(auth.methods).toEqual([{ kind: "social", provider: "apple" }]);
  });

  it("apple auto-applies sameSite='none' when registered", () => {
    // Apple uses response_mode=form_post — the state cookie needs
    // sameSite=none to ride the cross-site POST callback. Regression
    // guard: construct with Apple registered, ensure no throw and
    // Auth.methods reflects the registration.
    const auth = createAuth(
      baseConfig({
        methods: [
          {
            kind: "social",
            provider: "apple",
            clientId: "com.example.web",
            clientSecret: "JWT-placeholder",
          },
        ],
        bootstrapOwner: { match: "email", value: "owner@example.com" },
      }),
    );
    expect(auth.methods).toEqual([{ kind: "social", provider: "apple" }]);
  });

  it("merges provider-required trustedOrigins with configured trusted origins", () => {
    expect(
      buildTrustedOriginsFor(
        [
          {
            kind: "social",
            provider: "apple",
            clientId: "com.example.web",
            clientSecret: "JWT-placeholder",
          },
        ],
        ["https://platform.mantle.tools", "https://landing.mantle.tools"],
      ),
    ).toEqual([
      "https://appleid.apple.com",
      "https://platform.mantle.tools",
      "https://landing.mantle.tools",
    ]);
  });

  it("constructs when cross-subdomain cookies are configured", () => {
    const auth = createAuth(
      baseConfig({
        trustedOrigins: ["https://platform.mantle.tools", "https://landing.mantle.tools"],
        cookiePrefix: "mantle-platform",
        crossSubDomainCookies: {
          enabled: true,
          domain: "mantle.tools",
        },
      }),
    );
    expect(typeof auth.handler).toBe("function");
  });

});

describe("AuthMethodConfig — type narrowing smoke", () => {
  // A compile-time-only check that the union narrows where expected.
  // Lives as a test so a future refactor that accidentally widens
  // the union surfaces here.
  it("narrows social method to social fields", () => {
    const method: AuthMethodConfig = GITHUB_METHOD_FIXTURE;
    if (method.kind === "social") {
      // `provider` only exists on the social variant
      expect(method.provider).toBe("github");
    }
  });

  it("narrows email-otp method to email-otp fields", () => {
    const method: AuthMethodConfig = {
      kind: "email-otp",
      sender: NULL_SENDER,
      otpLength: 6,
    };
    if (method.kind === "email-otp") {
      expect(method.otpLength).toBe(6);
    }
  });
});

// --- listLinkedAccounts / unlinkAccount ---

interface FakeDbBehaviour {
  readonly allResults?: ReadonlyArray<Record<string, unknown>>;
  readonly runChanges?: number;
  readonly firstResult?: Record<string, unknown> | null;
  readonly onPrepare?: (sql: string) => void;
  readonly onBind?: (args: ReadonlyArray<unknown>) => void;
}

function fakeDbWith(behaviour: FakeDbBehaviour): D1Database {
  const stmt = {
    bind: (...args: unknown[]) => {
      behaviour.onBind?.(args);
      return stmt;
    },
    all: async () => ({
      results: behaviour.allResults ?? [],
      success: true,
      meta: {},
    }),
    run: async () => ({
      success: true,
      meta: { changes: behaviour.runChanges ?? 0 },
    }),
    first: async () => behaviour.firstResult ?? null,
  };
  return {
    prepare: (sql: string) => {
      behaviour.onPrepare?.(sql);
      return stmt;
    },
    exec: async () => ({ count: 0, duration: 0 }),
    batch: async () => [],
  } as unknown as D1Database;
}

describe("Auth.listLinkedAccounts", () => {
  it("maps D1 rows to LinkedAccountInfo and converts timestamps to Date", async () => {
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          allResults: [
            {
              id: "acc-1",
              providerId: "github",
              accountId: "gh-12345",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T03:04:05.000Z",
            },
            {
              id: "acc-2",
              providerId: "google",
              accountId: "g-67890",
              createdAt: "2026-01-03T00:00:00.000Z",
              updatedAt: "2026-01-04T00:00:00.000Z",
            },
          ],
        }),
      }),
    );
    const rows = await auth.listLinkedAccounts("user-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "acc-1",
      providerId: "github",
      accountId: "gh-12345",
    });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(rows[1]?.providerId).toBe("google");
  });

  it("returns an empty array when the user has no linked accounts", async () => {
    const auth = createAuth(
      baseConfig({ database: fakeDbWith({ allResults: [] }) }),
    );
    expect(await auth.listLinkedAccounts("user-1")).toEqual([]);
  });

  it("binds userId into the query", async () => {
    let captured: unknown = null;
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          allResults: [],
          onBind: (args) => {
            captured = args;
          },
        }),
      }),
    );
    await auth.listLinkedAccounts("user-xyz");
    // The most recent bind() call is for the listLinkedAccounts SELECT.
    expect(captured).toEqual(["user-xyz"]);
  });
});

describe("Auth.unlinkAccount", () => {
  it("returns true when a row was deleted", async () => {
    const auth = createAuth(
      baseConfig({ database: fakeDbWith({ runChanges: 1 }) }),
    );
    expect(await auth.unlinkAccount("user-1", "github")).toBe(true);
  });

  it("returns false when no row matched", async () => {
    const auth = createAuth(
      baseConfig({ database: fakeDbWith({ runChanges: 0 }) }),
    );
    expect(await auth.unlinkAccount("user-1", "github")).toBe(false);
  });

  it("binds (userId, providerId) in that order", async () => {
    let captured: unknown = null;
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          runChanges: 1,
          onBind: (args) => {
            captured = args;
          },
        }),
      }),
    );
    await auth.unlinkAccount("user-7", "google");
    expect(captured).toEqual(["user-7", "google"]);
  });

  it("does not block unlinking the last social — caller policy decides", async () => {
    // The runtime can't tell whether `email-otp` / `magic-link` are
    // registered methods, so unlinking the only credential row is
    // allowed at this layer. Documented in the Auth.unlinkAccount
    // JSDoc; this test pins the choice so a future "safety" guard
    // doesn't silently reverse it without a doc update.
    const auth = createAuth(
      baseConfig({ database: fakeDbWith({ runChanges: 1 }) }),
    );
    expect(await auth.unlinkAccount("user-1", "github")).toBe(true);
  });
});

// --- listUsers / setUserRole / inviteUser / revokeInvite (staff management) ---

describe("Auth.listUsers", () => {
  it("queries only staff roles and maps the result", async () => {
    const prepared: string[] = [];
    const binds: unknown[][] = [];
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          onPrepare: (sql) => prepared.push(sql),
          onBind: (args) => binds.push([...args]),
          allResults: [
            {
              id: "u-1",
              email: "a@example.com",
              name: "a",
              role: "owner",
              githubLogin: "a-gh",
              emailVerified: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      }),
    );
    const users = await auth.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: "u-1", emailVerified: true });
    expect(users[0]!.createdAt).toBeInstanceOf(Date);
    expect(prepared.at(-1)).toContain("WHERE role IN (?,?,?)");
    expect(binds.at(-1)).toEqual(STAFF_ROLES);
  });
});

describe("Auth.listMembers", () => {
  it("queries only non-staff users with escaped search and a keyset cursor", async () => {
    const prepared: string[] = [];
    const binds: unknown[][] = [];
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          onPrepare: (sql) => prepared.push(sql),
          onBind: (args) => binds.push([...args]),
          allResults: [
            {
              id: "u-1",
              email: "one@example.com",
              name: "One",
              emailVerified: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "u-2",
              email: "two@example.com",
              name: "Two",
              emailVerified: 0,
              createdAt: "2026-01-02T00:00:00.000Z",
            },
            {
              id: "u-3",
              email: "three@example.com",
              name: "Three",
              emailVerified: 1,
              createdAt: "2026-01-03T00:00:00.000Z",
            },
          ],
        }),
      }),
    );

    const result = await auth.listMembers({ limit: 2, search: "_%" });

    expect(result.items.map(({ id }) => id)).toEqual(["u-1", "u-2"]);
    expect(result.nextCursor && decodeMemberCursor(result.nextCursor)).toEqual([
      "2026-01-02T00:00:00.000Z",
      "u-2",
    ]);
    expect(result.previousCursor).toBeNull();
    expect(prepared.at(-1)).toContain("role IS NULL OR role NOT IN (?,?,?)");
    expect(prepared.at(-1)).toContain("LOWER(name) LIKE ?");
    expect(binds.at(-1)).toEqual([...STAFF_ROLES, "%\\_\\%%", "%\\_\\%%", 3]);
  });
});

describe("Auth.getUser", () => {
  it("maps one secret-free user projection", async () => {
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          firstResult: {
            id: "u-1",
            email: "owner@example.com",
            name: "Owner",
            image: "https://example.com/avatar.png",
            role: "owner",
            githubLogin: "owner-gh",
            emailVerified: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            refreshToken: "must-not-escape",
          },
        }),
      }),
    );

    expect(await auth.getUser!("u-1")).toEqual({
      id: "u-1",
      email: "owner@example.com",
      name: "Owner",
      image: "https://example.com/avatar.png",
      role: "owner",
      githubLogin: "owner-gh",
      emailVerified: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("returns null when the user does not exist", async () => {
    const auth = createAuth(baseConfig({ database: fakeDbWith({ firstResult: null }) }));

    expect(await auth.getUser!("missing")).toBeNull();
  });

  it("rejects a malformed stored timestamp", async () => {
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          firstResult: {
            id: "u-1",
            email: "owner@example.com",
            name: "Owner",
            image: null,
            role: "owner",
            githubLogin: null,
            emailVerified: 1,
            createdAt: "not-a-date",
          },
        }),
      }),
    );

    await expect(auth.getUser!("u-1")).rejects.toThrow(/invalid createdAt/);
  });
});

describe("Auth.setUserRole", () => {
  it("throws on a non-staff role string — programmer error, not operator input", async () => {
    const auth = createAuth(baseConfig({ database: fakeDbWith({}) }));
    await expect(
      auth.setUserRole("u-1", "superadmin" as never),
    ).rejects.toThrow(/not a staff role/);
  });

  it("binds (role, updatedAt, userId) and reports whether a row changed", async () => {
    const binds: unknown[][] = [];
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          runChanges: 1,
          onBind: (args) => binds.push([...args]),
        }),
      }),
    );
    expect(await auth.setUserRole("u-2", "editor")).toBe(true);
    const last = binds.at(-1)!;
    expect(last[0]).toBe("editor");
    expect(last[2]).toBe("u-2");
  });

  it("accepts null to revoke staff access", async () => {
    const binds: unknown[][] = [];
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          runChanges: 1,
          onBind: (args) => binds.push([...args]),
        }),
      }),
    );
    expect(await auth.setUserRole("u-2", null)).toBe(true);
    expect(binds.at(-1)![0]).toBeNull();
  });
});

describe("Auth.inviteUser", () => {
  it("returns exists with the prior row's id instead of inserting", async () => {
    const prepared: string[] = [];
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          firstResult: { id: "old-id" },
          onPrepare: (sql) => prepared.push(sql),
        }),
      }),
    );
    const result = await auth.inviteUser("Dup@Example.com", "editor");
    expect(result).toEqual({ kind: "exists", id: "old-id" });
    expect(prepared.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  });

  it("normalizes the email (trim + lowercase) and pre-creates the row with the role", async () => {
    const binds: unknown[][] = [];
    const prepared: string[] = [];
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          onPrepare: (sql) => prepared.push(sql),
          onBind: (args) => binds.push([...args]),
        }),
      }),
    );
    const result = await auth.inviteUser("  New@Example.COM ", "contributor");
    expect(result.kind).toBe("created");
    expect(result.id).toMatch(/^[0-9A-Za-z]{32}$/);
    const insertSql = prepared.find((sql) => sql.startsWith("INSERT"));
    expect(insertSql).toContain("emailVerified");
    const insertBinds = binds.at(-1)!;
    // (id, name, email, createdAt, updatedAt, role) — emailVerified is a literal 0
    expect(insertBinds[1]).toBe("new");
    expect(insertBinds[2]).toBe("new@example.com");
    expect(insertBinds[5]).toBe("contributor");
  });

  it("throws on a non-staff role", async () => {
    const auth = createAuth(baseConfig({ database: fakeDbWith({}) }));
    await expect(auth.inviteUser("x@example.com", "user" as never)).rejects.toThrow(
      /not a staff role/,
    );
  });
});

describe("Auth.revokeInvite", () => {
  it("issues a guarded DELETE (never-signed-in only) and reports the outcome", async () => {
    const prepared: string[] = [];
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
          runChanges: 1,
          onPrepare: (sql) => prepared.push(sql),
        }),
      }),
    );
    expect(await auth.revokeInvite("u-2")).toBe(true);
    const deleteSql = prepared.find((sql) => sql.startsWith("DELETE FROM user"));
    expect(deleteSql).toContain("emailVerified = 0");
    expect(deleteSql).toContain("NOT EXISTS");
  });

  it("returns false when the guard filtered the row out", async () => {
    const auth = createAuth(
      baseConfig({ database: fakeDbWith({ runChanges: 0 }) }),
    );
    expect(await auth.revokeInvite("active-user")).toBe(false);
  });
});
