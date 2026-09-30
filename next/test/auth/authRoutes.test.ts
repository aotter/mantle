import { describe, expect, it, vi } from "vitest";
import { createAuthRoutes, createCallerResolver, createMantleAuth, type AuthLike, type AuthRoutesAuth, type CreateMantleAuthOptions } from "../../src/auth/index.js";

const REDIRECT = "https://client.test/cb";
const complete = vi.fn(async (request: Request, accept: boolean) => {
  const q = (await request.formData()).get("oauth_query");
  if (q === "throw") throw new Error("bad signature");
  if (q === "js") return "javascript:alert(1)";
  return accept ? `${REDIRECT}?code=c1&state=${q}` : `${REDIRECT}?error=access_denied&state=${q}`;
});
const revoke = vi.fn(async (_user: string, id: string) => id === "c-1");
const handler = vi.fn(async (request: Request) => new Response(`better-auth ${new URL(request.url).pathname}`));
const auth: AuthRoutesAuth = {
  basePath: "/api/auth",
  handler,
  methods: [{ kind: "email-otp" }, { kind: "social", provider: "github" }],
  getOAuthConsentRequest: async (request) => {
    const q = new URL(request.url).searchParams;
    return q.get("client_id") ? { clientName: q.get("client_id") === "evil" ? "<b>Evil</b>" : "Claude", redirectUri: REDIRECT, scopes: ["mcp"], oauthQuery: new URL(request.url).search.slice(1) } : null;
  },
  completeOAuthConsent: complete,
  listOAuthConsents: async (user) => [{ id: "c-1", clientId: "claude", clientName: `Claude for ${user}`, scopes: ["mcp"] }],
  revokeOAuthConsent: revoke,
};
// a session cookie names the user; `authorization: Key k` is a service's own API key
const identity: AuthLike = {
  getSession: async (r) => (/(^|; )s=(\w+)/.exec(r.headers.get("cookie") ?? "") ? { session: { id: "sess" }, user: { id: /s=(\w+)/.exec(r.headers.get("cookie")!)![1]! } } : null),
  getUserRole: async () => null,
  verifyOAuthAccessToken: async () => ({ ok: false, status: 401, reason: "invalid-token" }),
};
const resolver = createCallerResolver(identity, {
  credentialResolver: (r) => (r.headers.get("authorization") === "Key k" ? { kind: "verified", credential: { credential: "api-key", credentialId: "k", subject: "key:k" } } : { kind: "not-handled" }),
});
const routes = createAuthRoutes(auth, { resolver });
const ORIGIN = "https://svc.test";
const req = (path: string, init: RequestInit & { session?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.session) headers.set("cookie", `s=${init.session}`);
  if (init.method === "POST") headers.set("content-type", "application/x-www-form-urlencoded");
  return routes(new Request(`${ORIGIN}${path}`, { ...init, headers }));
};
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

describe("createAuthRoutes: what goes to Better Auth", () => {
  it("answers the sign-in methods", async () => {
    const res = (await req("/api/auth/methods"))!;
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ methods: auth.methods });
  });

  it("hands the base path and the discovery metadata to Better Auth without resolving a caller, and nothing else", async () => {
    // a client authenticating with HTTP Basic at the token endpoint is Better Auth's to judge, not the caller resolver's
    const token = (await req("/api/auth/oauth2/token", { method: "POST", headers: { authorization: "Basic Y2xpZW50OnNlY3JldA==" }, body: "grant_type=client_credentials" }))!;
    expect(await token.text()).toBe("better-auth /api/auth/oauth2/token");
    for (const p of ["/.well-known/oauth-authorization-server/api/auth", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      expect(await (await req(p))!.text()).toBe(`better-auth ${p}`);
    }
    expect(await req("/.well-known/security.txt")).toBeNull();
    expect(await req("/admin")).toBeNull();
  });

  it("Better Auth serves both metadata documents natively, so Mantle writes none", async () => {
    let id: unknown;
    const stmt = { bind: (...a: unknown[]) => { id = a[0]; return stmt; }, first: async () => (typeof id === "string" && id.startsWith("auth-schema:") ? { id } : null), all: async () => ({ results: [], success: true, meta: {} }) };
    const real = createMantleAuth({
      database: { prepare: () => stmt, exec: async () => ({ count: 0, duration: 0 }), batch: async () => [] } as unknown as CreateMantleAuthOptions["database"],
      driver: { batch: async (s) => s.map((x) => ({ rows: [{ id: x.binds?.[0] ?? "auth-schema:1", n: 0 }], changes: 0 })) },
      ipAddressHeaders: ["x-real-ip"], baseURL: ORIGIN, secret: "x".repeat(40), methods: [{ kind: "social", provider: "github", options: { clientId: "g", clientSecret: "g" } }],
      oauthProvider: { loginPage: "/admin/sign-in", consentPage: "/oauth/consent", scopes: ["mcp"], mcpResource: `${ORIGIN}/mcp` },
    });
    const serve = createAuthRoutes(real, { resolver });
    const as = await (await serve(new Request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`)))!.json() as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: `${ORIGIN}/api/auth`, authorization_endpoint: expect.stringContaining("/api/auth/oauth2/authorize") });
    const pr = await (await serve(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)))!.json();
    expect(pr).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [`${ORIGIN}/api/auth`] });
  });
});

describe("createAuthRoutes: consent", () => {
  it("the consent request is the signed-in person's: anonymous and a key are 401", async () => {
    expect((await req("/oauth/consent/data?client_id=claude"))!.status).toBe(401);
    expect((await req("/oauth/consent/data?client_id=claude", { headers: { authorization: "Key k" } }))!.status).toBe(401);
    const ok = (await req("/oauth/consent/data?client_id=claude&scope=mcp", { session: "alice" }))!;
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(await ok.json()).toEqual({ consent: { clientName: "Claude", redirectUri: REDIRECT, scopes: ["mcp"], oauthQuery: "client_id=claude&scope=mcp" } });
    expect((await req("/oauth/consent/data", { session: "alice" }))!.status).toBe(400);
  });

  it("approve and deny redirect to the client with what Better Auth returned; the form cannot name the redirect", async () => {
    complete.mockClear();
    const approve = (await req("/oauth/consent", { method: "POST", session: "alice", body: form({ decision: "approve", oauth_query: "q1", redirect_uri: "https://evil.test/" }) }))!;
    expect(approve.status).toBe(302);
    expect(approve.headers.get("location")).toBe(`${REDIRECT}?code=c1&state=q1`);
    const deny = (await req("/oauth/consent", { method: "POST", session: "alice", body: form({ decision: "deny", oauth_query: "q2" }) }))!;
    expect(deny.headers.get("location")).toBe(`${REDIRECT}?error=access_denied&state=q2`);
    expect(complete.mock.calls.map((c) => c[1])).toEqual([true, false]);
  });

  it("refuses a bad decision, a failed or unsafe redirect, a key, and a cross-site post", async () => {
    complete.mockClear();
    expect((await req("/oauth/consent", { method: "POST", session: "alice", body: form({ decision: "maybe", oauth_query: "q" }) }))!.status).toBe(400);
    for (const q of ["throw", "js"]) {
      const res = (await req("/oauth/consent", { method: "POST", session: "alice", body: form({ decision: "approve", oauth_query: q }) }))!;
      expect([res.status, res.headers.get("location")]).toEqual([400, null]);
    }
    expect((await req("/oauth/consent", { method: "POST", headers: { authorization: "Key k" }, body: form({ decision: "approve", oauth_query: "q" }) }))!.status).toBe(401);
    const cross = (await req("/oauth/consent", { method: "POST", session: "alice", headers: { "sec-fetch-site": "cross-site", origin: "https://evil.test" }, body: form({ decision: "approve", oauth_query: "q" }) }))!;
    expect(cross.status).toBe(403);
    expect(complete.mock.calls.map((c) => c[1])).toEqual([true, true]); // only the two unsafe-redirect attempts reached Better Auth
  });

  it("lists and revokes the person's own connected apps", async () => {
    expect((await req("/oauth/consents/data"))!.status).toBe(401);
    expect(await (await req("/oauth/consents/data", { session: "alice" }))!.json()).toEqual({ consents: [{ id: "c-1", clientId: "claude", clientName: "Claude for alice", scopes: ["mcp"] }] });
    const ok = (await req("/oauth/consents/revoke", { method: "POST", session: "alice", body: form({ consent_id: "c-1" }) }))!;
    expect([ok.status, ok.headers.get("location")]).toEqual([303, "/oauth/consents"]);
    expect(revoke).toHaveBeenLastCalledWith("alice", "c-1");
    expect((await req("/oauth/consents/revoke", { method: "POST", session: "alice", body: form({ consent_id: "c-2" }) }))!.status).toBe(404);
    expect((await req("/oauth/consents/revoke", { method: "POST", session: "alice", body: "" }))!.status).toBe(400);
    expect((await req("/oauth/consents/revoke", { method: "POST", headers: { authorization: "Key k" }, body: form({ consent_id: "c-1" }) }))!.status).toBe(401);
    expect((await req("/oauth/consents/revoke", { method: "POST", session: "alice", headers: { "sec-fetch-site": "cross-site" }, body: form({ consent_id: "c-1" }) }))!.status).toBe(403);
  });

  it("without Admin the pages are plain HTML; with Admin the connected-apps page is Admin's", async () => {
    const page = (await req("/oauth/consent?client_id=evil", { headers: { "accept-language": "zh-TW" } }))!;
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://client.test;");
    const html = await page.text();
    expect(html).toContain("&#60;b&#62;Evil&#60;/b&#62;");
    expect(html).toContain('lang="zh-Hant-TW"');
    expect(html).toContain('name="oauth_query" value="client_id=evil"');
    expect((await req("/oauth/consent"))!.status).toBe(400);
    expect(await (await req("/oauth/consents", { session: "alice" }))!.text()).toContain('name="consent_id" value="c-1"');
    const withAdmin = createAuthRoutes(auth, { resolver, connectedAppsPage: "/admin/connected-apps" });
    expect((await withAdmin(new Request(`${ORIGIN}/oauth/consents`)))!.headers.get("location")).toBe("/admin/connected-apps");
  });
});
