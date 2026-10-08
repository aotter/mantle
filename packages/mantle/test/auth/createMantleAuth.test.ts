import { describe, expect, it, vi } from "vitest";
import { sqlite } from "./sqliteFixture.js";
import type { DatabaseDriver } from "../../src/core/index.js";
import {
  createMantleAuth,
  type AuthMethodConfig,
  type CreateMantleAuthOptions,
} from "../../src/auth/index.js";

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
  // every statement answers a row that satisfies the ledger check (the bound id) and a zero change count
  return { batch: async (statements) => statements.map((s) => ({ rows: [{ id: s.binds?.[0] ?? "auth-schema:1", n: 0 }], changes: 0 })) };
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

describe("createMantleAuth refuses to boot on a misconfiguration", () => {
  it.each([
    [{ ipAddressHeaders: [] }, /ipAddressHeaders/], // rate limits would key on a client-controlled header
    [{ ipAddressHeaders: ["", "  "] }, /ipAddressHeaders/],
    [{ basePath: "api/auth" }, /start with/],
    [{ basePath: "/" }, /not be/],
    [{ methods: [GITHUB_METHOD, { ...GITHUB_METHOD }] }, /github.*more than once/i],
    [{ methods: [GITHUB_METHOD, { kind: "oauth", options: { providerId: "github", clientId: "c", discoveryUrl: "https://idp.test/.well-known/openid-configuration" } }] }, /conflicts with a registered social provider id/],
  ] as [Partial<CreateMantleAuthOptions>, RegExp][])("%j", (overrides, why) => {
    expect(() => createMantleAuth(baseOptions(overrides))).toThrow(why);
  });

  it("boots behind any host's trusted header, and a base path loses its trailing slash", () => {
    expect(createMantleAuth(baseOptions({ ipAddressHeaders: [" x-real-ip "] })).basePath).toBe("/api/auth");
    expect(createMantleAuth(baseOptions({ basePath: "/auth/" })).basePath).toBe("/auth");
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
      const { d1: database, driver } = sqlite();
      const auth = createMantleAuth(
        baseOptions({ database, driver,
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
    const { d1: database, driver } = sqlite();
    const auth = createMantleAuth(baseOptions({ database, driver, oauthProvider: provider }));
    const response = await auth.handler(tokenRequest());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" });
  });
});

describe("createMantleAuth — jwt plugin", () => {
  it("get-session answers no set-auth-jwt header when the OAuth provider is configured (nothing reads it; signing it cost a jwks read per request)", async () => {
    const { d1: database, driver } = sqlite();
    const codes = new Map<string, string>();
    const auth = createMantleAuth(baseOptions({
      database, driver, baseURL: "http://localhost",
      methods: [{ kind: "email-otp", sender: { send: async ({ to, text }) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }],
      oauthProvider: { loginPage: "/admin/sign-in", consentPage: "/oauth/consent", scopes: ["mcp"] },
    }));
    const post = (path: string, body: unknown) =>
      auth.handler(new Request(`http://localhost/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "x-real-ip": "1.1.1.1" }, body: JSON.stringify(body) }));
    expect((await post("/email-otp/send-verification-otp", { email: "a@x.test", type: "sign-in" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20)); // the send is a background task
    const signedIn = await post("/sign-in/email-otp", { email: "a@x.test", otp: codes.get("a@x.test") });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const res = await auth.handler(new Request("http://localhost/api/auth/get-session", { headers: { cookie, "x-real-ip": "1.1.1.1" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { email: "a@x.test" } });
    expect(res.headers.get("set-auth-jwt")).toBeNull();
  });
});
