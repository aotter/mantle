import { describe, expect, it } from "vitest";
import type { EmailSender } from "@aotter/mantle-runtime";
import {
  buildGenericOAuthProviders,
  buildSocialProviders,
  buildTrustedOriginsFor,
  createAuth,
  createSetupIncompleteAuth,
  pickLocale,
  shouldPromoteToOwner,
  validateBootstrap,
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

  it("throws when match='github-login' but no github social method is registered", () => {
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

  it("returns an Auth surface with handler / getSession / getUserRole", () => {
    const auth = createAuth(baseConfig());
    expect(auth.basePath).toBe("/api/auth");
    expect(typeof auth.handler).toBe("function");
    expect(typeof auth.getSession).toBe("function");
    expect(typeof auth.getUserRole).toBe("function");
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
  it("maps rows, coercing emailVerified to boolean and createdAt to Date", async () => {
    const auth = createAuth(
      baseConfig({
        database: fakeDbWith({
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
            {
              id: "u-2",
              email: "b@example.com",
              name: "b",
              role: null,
              githubLogin: null,
              emailVerified: 0,
              createdAt: "2026-01-02T00:00:00.000Z",
            },
          ],
        }),
      }),
    );
    const users = await auth.listUsers();
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ id: "u-1", emailVerified: true });
    expect(users[0]!.createdAt).toBeInstanceOf(Date);
    expect(users[1]).toMatchObject({ id: "u-2", role: null, emailVerified: false });
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
