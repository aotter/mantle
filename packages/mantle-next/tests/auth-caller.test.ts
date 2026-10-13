/**
 * resolveCaller / authLoader against a REAL Better Auth instance: emailOTP sign-in, admin (role/banned), jwt and
 * oauthProvider, on the native d1Adapter over a bun:sqlite D1 shim. The auth handler is also served over a local HTTP
 * port, because Better Auth's resource client verifies access tokens against the instance's JWKS URL (baseURL + /jwks).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth/minimal";
import { admin, emailOTP, jwt } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { oauthProvider } from "@better-auth/oauth-provider";
import { oauthGrantExtension, oauthGrantHooks, oauthConsents, pruneLegacyOAuthClients } from "../src/auth/oauth.js";
import { authRoutes, loopbackClientsAreNative, normalizeAuthResponseCookies } from "../src/auth/routes.js";
import { ContractError } from "../src/kernel/contracts.js";
import { authLoader, resolveCaller, type AuthInstance } from "../src/auth/caller.js";
import { d1Adapter } from "../src/auth/adapter.js";
import { authSchemaSql } from "../src/auth/schema.js";
import { d1Shim } from "./apps/d1-shim.js";

const AUDIENCE = "https://api.example.test/mcp";
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => { for (const server of servers) server.stop(true); });

type App = Awaited<ReturnType<typeof makeApp>>;

async function makeApp(options: { cookiePrefix?: string; sessionTokenName?: string; sessionCache?: boolean; staffAdmin?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const otps: { email: string; otp: string }[] = [];
  const statements: string[] = [], native = d1Shim(sqlite);
  // Serve the handler first: baseURL (and so the JWKS URL and token issuer) must name the real port.
  let handle: (request: Request) => Promise<Response> = async () => new Response("not ready", { status: 503 });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => handle(request) });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  // baseURL carries the base path: the resource client derives the JWKS URL and the expected issuer from it as-is.
  const baseURL = `${origin}/api/auth`;
  const cache = new Map<string, string>();
  let cacheBroken = false;
  const ac = createAccessControl(defaultStatements);
  let boundAuth: AuthInstance;
  const betterAuthOptions = {
    databaseHooks: oauthGrantHooks(() => boundAuth),
    ...(options.sessionCache ? { verification: { storeInDatabase: true }, session: { storeSessionInDatabase: true }, secondaryStorage: { get: async (key: string) => cache.get(key) ?? null, set: async (key: string, value: string) => { if (cacheBroken) throw new Error("cache unavailable"); cache.set(key, value); }, delete: async (key: string) => { if (cacheBroken) throw new Error("cache unavailable"); cache.delete(key); }, getAndDelete: async () => { throw new Error("verification must remain in database"); }, increment: async () => { throw new Error("verification must remain in database"); } } } : {}),
    baseURL,
    secret: "test-secret-test-secret-test-secret-0123456789",
    database: d1Adapter({ prepare: sql => { statements.push(sql); return native.prepare(sql); } }),
    disabledPaths: ["/token"],
    advanced: {
      ...(options.cookiePrefix ? { cookiePrefix: options.cookiePrefix } : {}),
      ...(options.sessionTokenName ? { cookies: { session_token: { name: options.sessionTokenName } } } : {}),
    },
    plugins: [
      emailOTP({ sendVerificationOTP: async ({ email, otp }) => { otps.push({ email, otp }); } }),
      options.staffAdmin ? admin({ adminRoles: ["staff"], ac, roles: { staff: ac.newRole(defaultStatements) } }) : admin(),
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        extensions: [oauthGrantExtension],
        scopes: ["mcp", "openid"],
        resources: [AUDIENCE],
        enforcePerClientResources: false,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
  };
  for (const text of authSchemaSql(betterAuthOptions as never, "sqlite")) sqlite.run(text);
  const auth = betterAuth(betterAuthOptions);
  boundAuth = auth as unknown as AuthInstance;
  handle = request => auth.handler(request);
  let loads = 0;
  const loader = authLoader(async () => { loads++; return auth as unknown as AuthInstance; }, options.cookiePrefix ?? "better-auth");
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => auth.handler(new Request(`${baseURL}${path}`, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body) }));
  /** Email OTP sign-in through the real handler; returns the Cookie header and the user id. */
  async function signIn(email = "ada@example.test") {
    expect((await post("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
    const otp = otps.findLast(entry => entry.email === email)!.otp;
    const response = await post("/sign-in/email-otp", { email, otp });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().map(line => line.split(";")[0]).join("; ");
    const body = await response.json() as { user: { id: string } };
    return { cookie, userId: body.user.id, setCookies: response.headers.getSetCookie() };
  }
  const request = (headers: Record<string, string> = {}) => new Request(`${origin}/some/route`, { headers });
  return { sqlite, auth, loader, post, signIn, request, baseURL, loads: () => loads, breakCache: () => { cacheBroken = true; }, cache, statements };
}

describe("resolveCaller: session cookie", () => {
  test("1. no Cookie and no Authorization -> anonymous, the loader is never called", async () => {
    const app = await makeApp();
    expect(await resolveCaller(app.request(), app.loader)).toEqual({ kind: "anonymous" });
    expect(app.loads()).toBe(0);
  });

  test("2. only unrelated cookies -> anonymous, the loader is never called", async () => {
    const app = await makeApp();
    expect(await resolveCaller(app.request({ cookie: "_ga=1; theme=dark" }), app.loader)).toEqual({ kind: "anonymous" });
    expect(app.loads()).toBe(0);
  });

  test("3. email OTP sign-in -> user caller with session id and user role", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const sessionId = (app.sqlite.query("SELECT id FROM session WHERE userId = ?").get(userId) as { id: string }).id;
    const caller = await resolveCaller(app.request({ cookie }), app.loader);
    expect(caller).toEqual({ kind: "user", subject: userId, role: "user", scopes: [], credential: "session", credentialId: sessionId, clientId: null });
    expect(app.loads()).toBe(1);
  });

  test("4. role is re-read from the database on every request; application role strings are preserved", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const role = async () => (await resolveCaller(app.request({ cookie }), app.loader) as { role: unknown }).role;
    expect(await role()).toBe("user");
    app.sqlite.run("UPDATE user SET role = 'editor' WHERE id = ?", [userId]);
    expect(await role()).toBe("editor");
    app.sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [userId]);
    expect(await role()).toBe("admin");
    app.sqlite.run("UPDATE user SET role = 'owner' WHERE id = ?", [userId]);
    expect(await role()).toBe("owner");
  });

  test("5. a revoked session is anonymous on the next request", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    expect((await resolveCaller(app.request({ cookie }), app.loader)).kind).toBe("user");
    app.sqlite.run("DELETE FROM session WHERE userId = ?", [userId]);
    expect(await resolveCaller(app.request({ cookie }), app.loader)).toEqual({ kind: "anonymous" });
  });

  test("5b. auth.api.revokeSession revokes it too", async () => {
    const app = await makeApp();
    const { cookie } = await app.signIn();
    const headers = new Headers({ cookie });
    const token = decodeURIComponent(cookie.split("=")[1]!).split(".")[0]!;
    await app.auth.api.revokeSession({ headers, body: { token } });
    expect(await resolveCaller(app.request({ cookie }), app.loader)).toEqual({ kind: "anonymous" });
  });

  test("6. banned=1 in the DB: getSession still answers, resolveCaller is anonymous", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    app.sqlite.run("UPDATE user SET banned = 1 WHERE id = ?", [userId]);
    // Better Auth's getSession still returns a session for a banned user (the admin plugin only blocks session creation and
    // revokes sessions in banUser), so resolveCaller itself treats banned as anonymous.
    expect(await app.auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
    expect(await resolveCaller(app.request({ cookie }), app.loader)).toEqual({ kind: "anonymous" });
    // A temporary ban that has lapsed no longer applies.
    app.sqlite.run("UPDATE user SET banExpires = ? WHERE id = ?", [new Date(Date.now() - 60_000).toISOString(), userId]);
    expect((await resolveCaller(app.request({ cookie }), app.loader)).kind).toBe("user");
  });

  test("6b. admin plugin banUser revokes the user's sessions -> anonymous", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const staff = await app.signIn("root@example.test");
    app.sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [(app.sqlite.query("SELECT id FROM user WHERE email = 'root@example.test'").get() as { id: string }).id]);
    await app.auth.api.banUser({ headers: new Headers({ cookie: staff.cookie }), body: { userId } });
    expect(await resolveCaller(app.request({ cookie }), app.loader)).toEqual({ kind: "anonymous" });
  });

  test("7. authLoader refuses a mismatched cookiePrefix and a renamed session cookie; a retried get re-runs load", async () => {
    const app = await makeApp();
    let calls = 0;
    const mismatched = authLoader(async () => { calls++; return app.auth as unknown as AuthInstance; }, "app");
    await expect(mismatched.get()).rejects.toThrow(/cookiePrefix 'app'/);
    await expect(mismatched.get()).rejects.toThrow(/cookiePrefix 'app'/);
    expect(calls).toBe(2);
    const renamed = await makeApp({ sessionTokenName: "my_session" });
    let renamedCalls = 0;
    const loader = authLoader(async () => { renamedCalls++; return renamed.auth as unknown as AuthInstance; });
    await expect(loader.get()).rejects.toThrow(/session_token\.name/);
    await expect(loader.get()).rejects.toThrow(/session_token\.name/);
    expect(renamedCalls).toBe(2);
  });

  test("8. custom advanced.cookiePrefix works end to end", async () => {
    const app = await makeApp({ cookiePrefix: "app" });
    const { cookie, userId, setCookies } = await app.signIn();
    expect(setCookies.some(line => line.startsWith("app.session_token="))).toBe(true);
    const caller = await resolveCaller(app.request({ cookie }), app.loader);
    expect(caller).toMatchObject({ kind: "user", subject: userId, credential: "session" });
    // A loader left on the default prefix does not see the "app." cookie: anonymous without loading.
    const wrong = authLoader(async () => { throw new Error("must not load"); });
    expect(await resolveCaller(app.request({ cookie }), wrong)).toEqual({ kind: "anonymous" });
  });

  test("a session due for refresh hands its fresh Set-Cookie to responseHeaders, so the cookie slides", async () => {
    const app = await makeApp();
    const { cookie } = await app.signIn();
    // Within updateAge of expiry: Better Auth extends the session and re-sets the cookie.
    app.sqlite.run("UPDATE session SET expiresAt = ?", [new Date(Date.now() + 60_000).toISOString()]);
    const responseHeaders = new Headers();
    expect((await resolveCaller(app.request({ cookie }), app.loader, { responseHeaders })).kind).toBe("user");
    expect(responseHeaders.getSetCookie().some(c => c.includes("session_token="))).toBe(true);
    const { expiresAt } = app.sqlite.query("SELECT expiresAt FROM session").get() as { expiresAt: string };
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now() + 86_400_000);
  });

  test("real SDK refresh cookies survive merged headers; a revoke between validation and primary check wins", async () => {
    const app = await makeApp(), { cookie } = await app.signIn();
    app.sqlite.run("UPDATE session SET expiresAt = ?", [new Date(Date.now() + 60_000).toISOString()]);
    let revoked = false;
    const instance: AuthInstance = { options: app.auth.options, $context: app.auth.$context, api: { getSession: async input => {
      const result = await app.auth.api.getSession(input);
      if (revoked) app.sqlite.run("DELETE FROM session");
      const headers = new Headers({ "set-cookie": `${result.headers.getSetCookie().join(", ")}, state=fixture; Path=/; Expires=Wed, 21 Oct 2030 07:28:00 GMT` });
      return { ...result, headers };
    } } };
    const loader = authLoader(async () => instance), responseHeaders = new Headers({ "set-cookie": "existing=fixture; Path=/" });
    expect((await resolveCaller(app.request({ cookie }), loader, { responseHeaders })).kind).toBe("user");
    expect(responseHeaders.getSetCookie()).toHaveLength(3);
    expect(responseHeaders.getSetCookie()[2]).toBe("state=fixture; Path=/; Expires=Wed, 21 Oct 2030 07:28:00 GMT");
    revoked = true;
    const denied = new Headers();
    expect(await resolveCaller(app.request({ cookie }), loader, { responseHeaders: denied })).toEqual({ kind: "anonymous" });
    expect(denied.has("set-cookie")).toBe(false);
  });
});

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const REDIRECT = "https://client.example.test/callback";

/** The official authorization-code + PKCE flow against the live instance; returns the access token. */
async function oauthAccessToken(app: App, cookie: string, scope = "mcp", proof?: (url: string, method: string, token?: string) => Promise<string>) {
  const registered = await app.post("/oauth2/register", { client_name: "test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], scope });
  expect(registered.status).toBe(201);
  const client = await registered.json() as { client_id: string };

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: AUDIENCE });
  const authorize = await fetch(`${app.baseURL}/oauth2/authorize?${query}`, { headers: { cookie }, redirect: "manual" });
  const consentUrl = authorize.headers.get("location") ?? "";
  expect(consentUrl).toContain("/oauth/consent?");
  const consent = oauthConsents(app.auth as unknown as AuthInstance & { handler(request: Request): Promise<Response> });
  const location = await consent.completeOAuthConsent(new Request(`${app.baseURL}/oauth/consent`, { method: "POST", headers: { cookie, origin: new URL(app.baseURL).origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ oauth_query: new URL(consentUrl, app.baseURL).search.slice(1) }).toString() }), true);
  expect(location).toStartWith(REDIRECT);
  const code = new URL(location).searchParams.get("code")!;
  expect(code).toBeTruthy();
  const exchange = await fetch(`${app.baseURL}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(proof ? { DPoP: await proof(`${app.baseURL}/oauth2/token`, "POST") } : {}) }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: AUDIENCE }) });
  const token = await exchange.json() as { access_token?: string; scope?: string };
  expect(exchange.status, JSON.stringify(token)).toBe(200);
  return { accessToken: token.access_token!, clientId: client.client_id, scope: token.scope };
}

describe("resolveCaller: OAuth bearer", () => {
  const bearer = (app: App, token: string) => app.request({ authorization: `Bearer ${token}` });
  const code = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => (error instanceof ContractError ? error.code : `other: ${String(error)}`));

  test("9. real access token -> oauth user caller; role re-read; wrong audience / garbage / banned / no audience option -> UNAUTHENTICATED", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const { accessToken, clientId } = await oauthAccessToken(app, cookie);
    expect(accessToken.split(".")).toHaveLength(3);

    const caller = await resolveCaller(bearer(app, accessToken), app.loader, { audience: AUDIENCE });
    expect(caller).toMatchObject({ kind: "user", subject: userId, role: "user", scopes: ["mcp"], credential: "oauth", clientId, issuer: expect.any(String) });
    expect((caller as { credentialId: string | null }).credentialId).toBeTruthy();

    app.sqlite.run("UPDATE user SET role = 'editor' WHERE id = ?", [userId]);
    expect(await resolveCaller(bearer(app, accessToken), app.loader, { audience: AUDIENCE })).toMatchObject({ role: "editor" });
    app.sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [userId]);
    expect(await resolveCaller(bearer(app, accessToken), app.loader, { audience: AUDIENCE })).toMatchObject({ role: "admin" });

    expect(await code(resolveCaller(bearer(app, accessToken), app.loader, { audience: "https://other.example.test/mcp" }))).toBe("UNAUTHENTICATED");
    expect(await code(resolveCaller(bearer(app, "not.a.jwt"), app.loader, { audience: AUDIENCE }))).toBe("UNAUTHENTICATED");
    expect(await code(resolveCaller(bearer(app, accessToken), app.loader))).toBe("UNAUTHENTICATED");
    expect(await code(resolveCaller(bearer(app, accessToken), app.loader, { audience: [AUDIENCE, "https://other.example.test/mcp"] }))).toBe("resolved");

    app.sqlite.run("UPDATE user SET banned = 1 WHERE id = ?", [userId]);
    expect(await code(resolveCaller(bearer(app, accessToken), app.loader, { audience: AUDIENCE }))).toBe("UNAUTHENTICATED");
    app.sqlite.run("DELETE FROM user WHERE id = ?", [userId]);
    expect(await code(resolveCaller(bearer(app, accessToken), app.loader, { audience: AUDIENCE }))).toBe("UNAUTHENTICATED");
  });

  test("a Bearer header wins over a session cookie (an invalid token is never anonymous)", async () => {
    const app = await makeApp();
    const { cookie } = await app.signIn();
    expect(await code(resolveCaller(app.request({ cookie, authorization: "Basic junk" }), app.loader, { audience: AUDIENCE }))).toBe("UNAUTHENTICATED");
    expect(await code(resolveCaller(app.request({ cookie, authorization: "Bearer junk" }), app.loader, { audience: AUDIENCE }))).toBe("UNAUTHENTICATED");
  });
});


describe("OAuth grant revocation and consent routes", () => {
  test("revoke then call rejects issued JWT, cleans tokens/codes and does not resurrect it on reconsent", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const { accessToken, clientId } = await oauthAccessToken(app, cookie);
    const request = app.request({ authorization: `Bearer ${accessToken}` });
    expect(await resolveCaller(request, app.loader, { audience: AUDIENCE, scopes: ["mcp"] })).toMatchObject({ subject: userId });
    await expect(resolveCaller(request, app.loader, { audience: AUDIENCE, scopes: ["other"] })).rejects.toMatchObject({ code: "AUTH_DENIED" });
    const consents = oauthConsents(app.auth as unknown as AuthInstance & { handler(request: Request): Promise<Response> });
    const [consent] = await consents.listOAuthConsents(userId);
    expect(consent!.clientId).toBe(clientId);
    for (let i = 0; i < 105; i++) app.sqlite.run('INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)', [`pending-${i}`, `pending-${i}`, JSON.stringify({ type: "authorization_code", userId, query: { client_id: clientId } }), new Date(Date.now()+60000).toISOString(), new Date().toISOString(), new Date().toISOString()]);
    expect(await consents.revokeOAuthConsent("someone-else", consent!.id)).toBe(false);
    expect(await consents.revokeOAuthConsent(userId, consent!.id)).toBe(true);
    expect(app.sqlite.query("SELECT count(*) AS n FROM verification WHERE id LIKE 'pending-%'").get()).toEqual({ n: 0 });
    await expect(resolveCaller(request, app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const { adapter } = await app.auth.$context;
    await adapter.create({ model: "oauthConsent", data: { clientId, userId, scopes: ["mcp"], resources: [AUDIENCE], createdAt: new Date(), updatedAt: new Date() } });
    await expect(resolveCaller(request, app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  test("expired/deleted session and withdrawn scope fail on next bearer call", async () => {
    const app = await makeApp(); const { cookie, userId } = await app.signIn();
    const { accessToken } = await oauthAccessToken(app, cookie);
    const request = app.request({ authorization: `Bearer ${accessToken}` });
    app.sqlite.run('UPDATE oauthConsent SET scopes = ?', ['[]']);
    await expect(resolveCaller(request, app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    app.sqlite.run('UPDATE oauthConsent SET scopes = ?', ['["mcp"]']);
    app.sqlite.run('UPDATE session SET expiresAt = ? WHERE userId = ?', [new Date(0).toISOString(), userId]);
    await expect(resolveCaller(request, app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    app.sqlite.run('DELETE FROM session WHERE userId = ?', [userId]);
    await expect(resolveCaller(request, app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  test("methods never loads auth; session-only connected apps, localized HTML and origin-checked writes", async () => {
    const app = await makeApp(); const routes = authRoutes(app.loader as never, { methods: [{ kind: "email-otp" }] });
    expect(await (await routes(new Request(`${app.baseURL}/methods`)))!.json()).toEqual({ methods: [{ kind: "email-otp" }] });
    expect(app.loads()).toBe(0);
    expect(await routes(new Request('https://service.test/unowned'))).toBeNull();
    const { cookie, userId } = await app.signIn();
    const { accessToken } = await oauthAccessToken(app, cookie);
    const origin = new URL(app.baseURL).origin;
    const page = await routes(new Request(`${origin}/oauth/consents`, { headers: { cookie, "accept-language": "zh-TW" } }));
    expect(page!.status).toBe(200); expect(await page!.text()).toContain("中斷連線");
    expect(page!.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect((await routes(new Request(`${origin}/oauth/consents/data`, { headers: { authorization: `Bearer ${accessToken}` } })))!.status).toBe(401);
    const [consent] = await oauthConsents(app.auth as never).listOAuthConsents(userId);
    expect((await routes(new Request(`${origin}/oauth/consents/revoke`, { method: "POST", headers: { cookie, origin: "https://evil.test" }, body: `consent_id=${consent!.id}` })))!.status).toBe(403);
    expect((await routes(new Request(`${origin}/oauth/consents/revoke`, { method: "POST", headers: { cookie, origin }, body: `consent_id=${consent!.id}` })))!.status).toBe(303);
    const redirected = authRoutes(app.loader as never, { methods: [], connectedAppsPage: "/admin/connected-apps" });
    expect((await redirected(new Request(`${origin}/oauth/consents`, { headers: { cookie } })))!.headers.get("location")).toBe("/admin/connected-apps");
  });
  test("DPoP with session KV cache is bound to request and single-use database proof", async () => {
    const app = await makeApp({ sessionCache: true }); const { cookie, userId } = await app.signIn();
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
    const proof = async (url: string, method: string, token?: string) => {
      const header = Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ jti: crypto.randomUUID(), iat: Math.floor(Date.now()/1000), htm: method, htu: url, ...(token ? { ath: b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))) } : {}) })).toString("base64url");
      return `${header}.${payload}.${b64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(`${header}.${payload}`))))}`;
    };
    const { accessToken } = await oauthAccessToken(app, cookie, "mcp", proof);
    const url = app.request().url;
    const dpop = await proof(url, "GET", accessToken);
    const request = new Request(url, { headers: { authorization: `DPoP ${accessToken}`, dpop } });
    expect(await resolveCaller(request, app.loader, { audience: AUDIENCE })).toMatchObject({ credential: "oauth" });
    await expect(resolveCaller(request, app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(resolveCaller(new Request(url, { method: "POST", headers: { authorization: `DPoP ${accessToken}`, dpop: await proof(url, "GET", accessToken) } }), app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(resolveCaller(app.request({ authorization: `Bearer ${accessToken}` }), app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const consents = oauthConsents(app.auth as never);
    const [consent] = await consents.listOAuthConsents(userId);
    expect(await consents.revokeOAuthConsent(userId, consent!.id)).toBe(true);
    await expect(resolveCaller(new Request(url, { headers: { authorization: `DPoP ${accessToken}`, dpop: await proof(url, "GET", accessToken) } }), app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  test("consent boundary rejects oversized streaming bodies, invalid decisions and invalid signed query", async () => {
    const app = await makeApp(); const { cookie } = await app.signIn();
    const origin = new URL(app.baseURL).origin;
    const routes = authRoutes(app.loader as never, { methods: [] });
    expect((await routes(new Request(`${origin}/oauth/consent/data`, { headers: { cookie } })))!.status).toBe(400);
    expect((await routes(new Request(`${origin}/oauth/consent`, { method: "POST", headers: { cookie, origin }, body: "decision=other" })))!.status).toBe(400);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); controller.close(); } });
    const response = await routes(new Request(`${origin}/oauth/consents/revoke`, { method: "POST", headers: { cookie, origin }, body: stream, duplex: "half" } as RequestInit));
    expect(response!.status).toBe(400); expect(response!.headers.get("cache-control")).toContain("no-store");
    expect(() => authRoutes(app.loader as never, { methods: [], connectedAppsPage: "/\\evil.test" })).toThrow("same-origin");
  });
  test("raw and encoded SDK admin routes ignore stale staff KV after demotion, ban or session deletion", async () => {
    const app = await makeApp({ sessionCache: true, staffAdmin: true });
    const signed = await app.signIn();
    app.sqlite.run("UPDATE user SET role = 'staff' WHERE id = ?", [signed.userId]);
    const { cookie } = await app.signIn();
    const routes = authRoutes(app.loader as never, { methods: [] });
    const call = (path = "/admin/list-users") => routes(new Request(`${app.baseURL}${path}?limit=1`, { headers: { cookie } }));
    expect((await call())!.status).toBe(200);
    app.breakCache();
    app.sqlite.run("UPDATE user SET role = 'user' WHERE id = ?", [signed.userId]);
    // The exact SDK API still trusts its cached staff snapshot; our public HTTP boundary must not.
    expect(((await app.auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } }))!.user as { role?: string }).role).toBe("staff");
    expect((await call())!.status).toBe(403);
    expect((await call("/%61dmin/list-users"))!.status).toBe(403);
    app.sqlite.run("UPDATE user SET role = 'staff', banned = 1 WHERE id = ?", [signed.userId]);
    expect((await call())!.status).toBe(401);
    app.sqlite.run("UPDATE user SET banned = 0 WHERE id = ?", [signed.userId]);
    const hostile = await routes(new Request(`${app.baseURL}/%61dmin/set-role`, { method: "POST", headers: { cookie, origin: "https://evil.test", "content-type": "application/json" }, body: "{}" }));
    expect(hostile!.status).toBe(403); expect((await hostile!.json() as { error: { path: string } }).error.path).toBe("request:origin");
    app.sqlite.run("DELETE FROM session WHERE userId = ?", [signed.userId]);
    expect((await call())!.status).toBe(401);
    expect((await call("/%61dmin/list-users"))!.status).toBe(401);
  });
  test("an expired primary session cannot refresh from a still-valid KV snapshot", async () => {
    const app = await makeApp({ sessionCache: true, staffAdmin: true });
    const signed = await app.signIn(); app.sqlite.run("UPDATE user SET role = 'staff' WHERE id = ?", [signed.userId]);
    const { cookie } = await app.signIn();
    for (const [key, text] of app.cache) {
      const value = JSON.parse(text);
      if (value.session?.userId === signed.userId) { value.session.expiresAt = new Date(Date.now()+60000).toISOString(); app.cache.set(key, JSON.stringify(value)); }
    }
    const expired = new Date(Date.now()-60000).toISOString();
    app.sqlite.run("UPDATE session SET expiresAt = ? WHERE userId = ?", [expired, signed.userId]);
    const responseHeaders = new Headers();
    expect(await resolveCaller(app.request({ cookie }), app.loader, { responseHeaders })).toEqual({ kind: "anonymous" });
    expect(responseHeaders.has("set-cookie")).toBe(false);
    const routes = authRoutes(app.loader as never, { methods: [] });
    expect((await routes(new Request(`${app.baseURL}/%61dmin/list-users`, { headers: { cookie } })))!.status).toBe(401);
    expect(app.sqlite.query("SELECT expiresAt FROM session WHERE userId = ?").all(signed.userId)).toEqual([{ expiresAt: expired }, { expiresAt: expired }]);
  });
  test("supported database-only auth config keeps raw SDK get-session under primary expiry", async () => {
    const app = await makeApp(); const { cookie, userId } = await app.signIn();
    for (const [key, text] of app.cache) {
      const value = JSON.parse(text);
      if (value.session?.userId === userId) { value.session.expiresAt = new Date(Date.now()+60000).toISOString(); app.cache.set(key, JSON.stringify(value)); }
    }
    const expired = new Date(Date.now()-60000).toISOString(); app.sqlite.run("UPDATE session SET expiresAt = ? WHERE userId = ?", [expired, userId]);
    const routes = authRoutes(app.loader as never, { methods: [] });
    const response = await routes(new Request(`${app.baseURL}/get-session`, { headers: { cookie } }));
    expect(response!.status).toBe(200); expect(await response!.json()).toBeNull();
    const rows = app.sqlite.query("SELECT expiresAt FROM session WHERE userId = ?").all(userId) as { expiresAt: string }[];
    expect(rows.every(row => row.expiresAt === expired)).toBe(true);
    expect(await resolveCaller(app.request({ cookie }), app.loader)).toEqual({ kind: "anonymous" });
  });
  test("bearer authority is one native JOIN; connected apps is one JOIN in updated order", async () => {
    const app = await makeApp(); const { cookie, userId } = await app.signIn();
    const { accessToken } = await oauthAccessToken(app, cookie);
    app.statements.length = 0;
    expect(await resolveCaller(app.request({ authorization: `Bearer ${accessToken}` }), app.loader, { audience: AUDIENCE })).toMatchObject({ subject: userId });
    expect(app.statements.filter(sql => sql.includes('FROM "oauthConsent"'))).toHaveLength(1);
    expect(app.statements.some(sql => sql.includes('JOIN "session"') && sql.includes('JOIN "user"'))).toBe(true);
    expect(app.statements.some(sql => /FROM "user"/.test(sql))).toBe(false);
    const { adapter } = await app.auth.$context;
    for (const [clientId, updatedAt] of [["older", new Date(0)], ["newer", new Date(Date.now()+60000)]] as const) {
      await adapter.create({ model: "oauthClient", data: { clientId, name: clientId, redirectUris: [REDIRECT], createdAt: new Date(), updatedAt } });
      await adapter.create({ model: "oauthConsent", data: { clientId, userId, resources: [AUDIENCE], scopes: ["mcp"], createdAt: new Date(), updatedAt } });
    }
    app.statements.length = 0;
    const apps = await oauthConsents(app.auth as never).listOAuthConsents(userId);
    expect(apps.map(row => row.clientId)).toEqual(["newer", expect.any(String), "older"]);
    expect(apps.map(row => row.clientName)).toEqual(["newer", "test", "older"]);
    expect(app.statements).toHaveLength(1); expect(app.statements[0]).toContain('ORDER BY c."updatedAt" DESC');
  });
  test("merged Set-Cookie headers are split without breaking Expires commas", async () => {
    const response = await normalizeAuthResponseCookies(new Response("body", { status: 201, headers: { "set-cookie": "session=a; Path=/; Expires=Wed, 21 Oct 2030 07:28:00 GMT, state=b; Path=/" } }));
    expect(response.status).toBe(201); expect(await response.text()).toBe("body");
    expect(response.headers.getSetCookie()).toEqual(["session=a; Path=/; Expires=Wed, 21 Oct 2030 07:28:00 GMT", "state=b; Path=/"]);
    const legacy = new Response(null, { headers: { "set-cookie": "a=1; Path=/, b=2; Path=/" } });
    Object.defineProperty(legacy.headers, "getSetCookie", { value: undefined });
    expect((await normalizeAuthResponseCookies(legacy)).headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
  test("secondary storage without primary sessions fails at loader setup with ContractError", async () => {
    const app = await makeApp();
    const loader = authLoader(async () => ({ ...app.auth, options: { ...app.auth.options, session: { storeSessionInDatabase: false }, secondaryStorage: { get: async () => null, set: async () => {}, delete: async () => {} } } }) as unknown as AuthInstance);
    await expect(loader.get()).rejects.toMatchObject({ name: "ContractError", code: "AUTH_CONFIGURATION_ERROR", path: "auth:session" });
  });
  test("app-owned credential hook precedes OAuth/cookies and never falls back after denial", async () => {
    const app = await makeApp(); const { cookie } = await app.signIn();
    const credential = { kind: "user", subject: "api-user", role: null, scopes: ["mcp"], credential: "api-key", credentialId: "key-id", clientId: null } as const;
    expect(await resolveCaller(app.request({ cookie, authorization: "Bearer invalid" }), app.loader, { scopes: ["mcp"], resolveCredential: () => credential })).toEqual(credential);
    await expect(resolveCaller(app.request({ cookie }), app.loader, { scopes: ["other"], resolveCredential: () => credential })).rejects.toMatchObject({ code: "AUTH_DENIED" });
    await expect(resolveCaller(app.request({ cookie }), app.loader, { resolveCredential: () => { throw new ContractError("UNAUTHENTICATED", "Invalid key."); } })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  test("scheduled legacy DCR pruning keeps new, owned, reference and CIMD clients", async () => {
    const app = await makeApp(); const { adapter } = await app.auth.$context;
    const { userId } = await app.signIn();
    const old = new Date(0);
    for (const [clientId, extra] of [["old", {}], ["new", { createdAt: new Date() }], ["owned", { userId }], ["reference", { referenceId: "ref" }], ["cimd", { clientDiscoveryId: "cimd" }]] as const) await adapter.create({ model: "oauthClient", data: { clientId, createdAt: old, updatedAt: old, redirectUris: [REDIRECT], ...extra } });
    expect(await pruneLegacyOAuthClients(app.auth as never)).toBe(1);
    expect((await adapter.findMany<{ clientId: string }>({ model: "oauthClient" })).map(x => x.clientId).sort()).toEqual(["cimd", "new", "owned", "reference"]);
  });
  test("loopback DCR is native only for all valid loopback http callbacks; explicit types and mixed hosts untouched", async () => {
    const request = (body: unknown) => new Request("https://service.test/api/auth/oauth2/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const rewritten = await loopbackClientsAreNative(request({ redirect_uris: ["http://localhost:123/cb", "http://127.0.0.1:456/cb", "http://[::1]:789/cb"] }));
    expect(await rewritten.json()).toMatchObject({ application_type: "native" });
    for (const body of [{ redirect_uris: ["http://localhost/cb", "https://evil.test/cb"] }, { redirect_uris: ["http://127.0.0.1/cb"], application_type: "web" }, { redirect_uris: [] }, { redirect_uris: ["http://localhost.evil.test/cb"] }]) {
      const req = request(body); expect(await loopbackClientsAreNative(req)).toBe(req);
    }
  });
});
