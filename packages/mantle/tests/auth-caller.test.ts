import { fixtureCaller } from "./apps/fixtures.js";
/**
 * resolveCaller / authLoader against a REAL Better Auth instance: emailOTP sign-in, admin plugin (role/banned), jwt and
 * oauthProvider, on the native d1Adapter over a bun:sqlite D1 shim. The auth handler is also served over a local HTTP
 * port, because Better Auth's resource client verifies access tokens against the instance's JWKS URL (baseURL + /jwks).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { authenticatedAs } from "../src/testing/index.js";
import { fieldsOf, rolesOf } from "../src/kernel/caller-identity.js";
import type { BetterAuthOptions } from "better-auth/types";
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth/minimal";
import { admin as adminFunction, customSession, emailOTP, jwt, magicLink, phoneNumber } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { oauthProvider } from "@better-auth/oauth-provider";
import { oauthGrantExtension, oauthGrantRevocation, oauthConsents, pruneLegacyOAuthClients } from "../src/auth/oauth.js";
import { authRoutes, loopbackClientsAreNative, normalizeAuthResponseCookies } from "../src/auth/routes.js";
import { ContractError } from "../src/kernel/contracts.js";
import { authLoader, resolveCaller, type AuthInstance } from "../src/auth/caller.js";
import { d1Adapter } from "../src/auth/adapter.js";
import { authSchemaSql } from "../src/infrastructure/authSchema.js";
import { d1Shim } from "./apps/d1-shim.js";

const AUDIENCE = "https://api.example.test/mcp";
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => { for (const server of servers) server.stop(true); });

type App = Awaited<ReturnType<typeof makeApp>>;

async function makeApp(options: { cookiePrefix?: string; sessionTokenName?: string; sessionCache?: boolean; customAdmin?: boolean; additionalFields?: NonNullable<BetterAuthOptions["user"]>["additionalFields"]; derivedRegion?: boolean; localOnly?: boolean; magicLinkStore?: "plain" | "hashed"; fullBaseURL?: boolean; basePath?: string; jwtOptions?: (baseURL: string) => Parameters<typeof jwt>[0] } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const otps: { email: string; otp: string }[] = [], resets: string[] = [], phoneOtps: string[] = [], links: string[] = [];
  const statements: string[] = [], native = d1Shim(sqlite);
  // Serve the handler first: baseURL (and so the JWKS URL and token issuer) must name the real port.
  let handle: (request: Request) => Promise<Response> = async () => new Response("not ready", { status: 503 });
  const server = options.localOnly ? undefined : Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => handle(request) });
  if (server) servers.push(server);
  const origin = `http://127.0.0.1:${server?.port ?? 3000}`;
  const basePath = options.basePath ?? "/api/auth";
  const baseURL = `${origin}${basePath}`;
  const cache = new Map<string, string>();
  let cacheBroken = false;
  const ac = createAccessControl(defaultStatements);
  const betterAuthOptions = {
    user: { additionalFields: options.additionalFields },
    ...(options.sessionCache ? { verification: { storeInDatabase: true }, session: { storeSessionInDatabase: true }, secondaryStorage: { get: async (key: string) => cache.get(key) ?? null, set: async (key: string, value: string) => { if (cacheBroken) throw new Error("cache unavailable"); cache.set(key, value); }, delete: async (key: string) => { if (cacheBroken) throw new Error("cache unavailable"); cache.delete(key); }, getAndDelete: async () => { throw new Error("verification must remain in database"); }, increment: async () => { throw new Error("verification must remain in database"); } } } : {}),
    ...(options.fullBaseURL ? { baseURL } : { baseURL: origin, basePath }),
    secret: "test-secret-test-secret-test-secret-0123456789",
    database: d1Adapter({ prepare: sql => { statements.push(sql); return native.prepare(sql); } }),
    disabledPaths: ["/token"],
    emailAndPassword: { enabled: true, sendResetPassword: async ({ token }: { token: string }) => { resets.push(token); } },
    advanced: {
      ...(options.cookiePrefix ? { cookiePrefix: options.cookiePrefix } : {}),
      ...(options.sessionTokenName ? { cookies: { session_token: { name: options.sessionTokenName } } } : {}),
    },
    plugins: [
      ...(options.derivedRegion ? [customSession(async ({ user, session }) => ({ user: { ...user, region: ['TW'] }, session }))] : []),
      emailOTP({ sendVerificationOTP: async ({ email, otp }) => { otps.push({ email, otp }); } }),
      phoneNumber({ sendOTP: () => {}, sendPasswordResetOTP: async ({ code }) => { phoneOtps.push(code); } }),
      magicLink({ storeToken: options.magicLinkStore ?? "plain", sendMagicLink: async ({ token }) => { links.push(token); } }),
      options.customAdmin ? adminFunction({ adminRoles: ["admin"], ac, roles: { admin: ac.newRole(defaultStatements) } }) : adminFunction(),
      jwt({ disableSettingJwtHeader: true, ...options.jwtOptions?.(baseURL) }),
      oauthGrantRevocation(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        extensions: [oauthGrantExtension],
        scopes: ["mcp", "openid", "offline_access"],
        resources: [AUDIENCE],
        enforcePerClientResources: false,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
  };
  for (const text of authSchemaSql(betterAuthOptions as never, "sqlite")) sqlite.run(text);
  const auth = betterAuth(betterAuthOptions);
  handle = async request => {
    if (new URL(request.url).pathname === "/external-jwks") {
      const keys = sqlite.query("SELECT id, publicKey, alg FROM jwks").all() as { id: string; publicKey: string; alg: string }[];
      return Response.json({ keys: keys.map(key => ({ ...JSON.parse(key.publicKey), kid: key.id, alg: key.alg })) });
    }
    return auth.handler(request);
  };
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
  return { sqlite, auth, loader, post, signIn, request, baseURL, resets, otps, phoneOtps, links, origin, loads: () => loads, breakCache: () => { cacheBroken = true; }, cache, statements };
}

describe("resolveCaller: session cookie", () => {

  test("3. email OTP sign-in -> user caller with session id and user role", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const sessionId = (app.sqlite.query("SELECT id FROM session WHERE userId = ?").get(userId) as { id: string }).id;
    const caller = await resolveCaller(app.request({ cookie }), app.loader);
    expect(caller).toEqual(fixtureCaller({ kind: "user", subject: userId, role: "user", admin: false, scopes: [], credential: "session", credentialId: sessionId, clientId: null }));
    expect(app.loads()).toBe(1);
  });

  test("5b. auth.api.revokeSession revokes it too", async () => {
    const app = await makeApp();
    const { cookie } = await app.signIn();
    const headers = new Headers({ cookie });
    const token = decodeURIComponent(cookie.split("=")[1]!).split(".")[0]!;
    await app.auth.api.revokeSession({ headers, body: { token } });
    expect(await resolveCaller(app.request({ cookie }), app.loader)).toEqual({ kind: "anonymous" });
  });

  test("6b. admin plugin banUser revokes the user's sessions -> anonymous", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const admin = await app.signIn("root@example.test");
    app.sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [(app.sqlite.query("SELECT id FROM user WHERE email = 'root@example.test'").get() as { id: string }).id]);
    await app.auth.api.banUser({ headers: new Headers({ cookie: admin.cookie }), body: { userId } });
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

  test("one primary result is the authority snapshot; a later revoke applies to the next request", async () => {
    const app = await makeApp(), { cookie, userId } = await app.signIn();
    let revoked = false;
    const instance: AuthInstance = { options: app.auth.options, $context: app.auth.$context, api: { getSession: async input => {
      const result = await app.auth.api.getSession(input);
      if (!revoked) { app.sqlite.run("DELETE FROM session"); revoked = true; }
      return result;
    } } };
    const loader = authLoader(async () => instance);
    app.statements.length = 0;
    expect(await resolveCaller(app.request({ cookie }), loader)).toMatchObject({ kind: "user", subject: userId });
    expect(app.statements.filter(text => /^\s*(SELECT|WITH)\b/i.test(text))).toHaveLength(2);
    expect(await resolveCaller(app.request({ cookie }), loader)).toEqual({ kind: "anonymous" });
  });

  test("real SDK refresh cookies survive merged headers; revocation wins over the secondary snapshot", async () => {
    const app = await makeApp({ sessionCache: true }), { cookie } = await app.signIn();
    app.sqlite.run("UPDATE session SET expiresAt = ?", [new Date(Date.now() + 60_000).toISOString()]);
    for (const [key, text] of app.cache) {
      const value = JSON.parse(text);
      if (value.session) { value.session.expiresAt = new Date(Date.now() + 60_000).toISOString(); app.cache.set(key, JSON.stringify(value)); }
    }
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

/** An authorization request with PKCE; the location is the consent page, or the client callback with a code when consent exists. */
async function authorize(app: App, cookie: string, clientId: string, scope: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: AUDIENCE });
  const response = await fetch(`${app.baseURL}/oauth2/authorize?${query}`, { headers: { cookie }, redirect: "manual" });
  return { location: response.headers.get("location") ?? "", verifier };
}
const exchange = (app: App, clientId: string, code: string, verifier: string) => fetch(`${app.baseURL}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: AUDIENCE }) });

/** The official authorization-code + PKCE flow against the live instance; returns the access token. */
async function oauthAccessToken(app: App, cookie: string, scope = "mcp", proof?: (url: string, method: string, token?: string) => Promise<string>, skipConsent = false) {
  const registered = await app.post("/oauth2/register", { client_name: "test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: scope.includes("offline_access") ? ["authorization_code", "refresh_token"] : ["authorization_code"], response_types: ["code"], scope });
  expect(registered.status).toBe(201);
  const client = await registered.json() as { client_id: string };

  if (skipConsent) await (await app.auth.$context).adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: client.client_id }], update: { skipConsent: true } });

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: AUDIENCE });
  const authorize = await fetch(`${app.baseURL}/oauth2/authorize?${query}`, { headers: { cookie }, redirect: "manual" });
  const consentUrl = authorize.headers.get("location") ?? "";
  if (!skipConsent) expect(consentUrl).toContain("/oauth/consent?");
  const consent = oauthConsents(app.auth as unknown as AuthInstance & { handler(request: Request): Promise<Response> });
  const location = skipConsent ? consentUrl : await consent.completeOAuthConsent(new Request(`${app.baseURL}/oauth/consent`, { method: "POST", headers: { cookie, origin: new URL(app.baseURL).origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ oauth_query: new URL(consentUrl, app.baseURL).search.slice(1) }).toString() }), true);
  expect(location).toStartWith(REDIRECT);
  const code = new URL(location).searchParams.get("code")!;
  expect(code).toBeTruthy();
  const exchange = await fetch(`${app.baseURL}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(proof ? { DPoP: await proof(`${app.baseURL}/oauth2/token`, "POST") } : {}) }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: AUDIENCE }) });
  const token = await exchange.json() as { access_token?: string; refresh_token?: string; scope?: string };
  expect(exchange.status, JSON.stringify(token)).toBe(200);
  return { accessToken: token.access_token!, refreshToken: token.refresh_token, clientId: client.client_id, scope: token.scope };
}

describe("resolveCaller: OAuth bearer", () => {
  const bearer = (app: App, token: string) => app.request({ authorization: `Bearer ${token}` });
  const code = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => (error instanceof ContractError ? error.code : `other: ${String(error)}`));

  test.each([
    ["origin + basePath (shipped app-shell)", {}],
    ["full-path baseURL", { fullBaseURL: true }],
    ["custom auth path", { basePath: "/identity" }],
    ["custom JWT issuer and JWKS path", { jwtOptions: () => ({ jwt: { issuer: "https://issuer.example.test" }, jwks: { jwksPath: "/keys" } }) }],
    ["remote JWKS URL", { jwtOptions: (baseURL: string) => ({ jwks: { remoteUrl: `${new URL(baseURL).origin}/external-jwks`, keyPairConfig: { alg: "EdDSA" as const } } }) }],
  ] as const)("issued bearer uses authoritative issuer and JWKS: %s", async (_name, options) => {
    const app = await makeApp(options), { cookie, userId } = await app.signIn();
    const { accessToken } = await oauthAccessToken(app, cookie);
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString());
    expect(await resolveCaller(bearer(app, accessToken), app.loader, { audience: AUDIENCE })).toMatchObject({ subject: userId, issuer: claims.iss });

    // Same valid signing key and live grant: only the issuer is wrong.
    const resigned = await app.auth.api.signJWT({ body: { payload: claims } });
    expect(await resolveCaller(bearer(app, resigned.token), app.loader, { audience: AUDIENCE })).toMatchObject({ subject: userId });
    const wrong = await app.auth.api.signJWT({ body: { payload: { ...claims, iss: "https://wrong-issuer.example.test" } } });
    expect(JSON.parse(Buffer.from(wrong.token.split(".")[1]!, "base64url").toString())).toEqual({ ...claims, iss: "https://wrong-issuer.example.test" });
    const failure = await resolveCaller(bearer(app, wrong.token), app.loader, { audience: AUDIENCE }).catch(error => error);
    expect(failure).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  test("app-shell issued bearer initializes MCP and lists Admin tools", async () => {
    const app = await makeApp(), { cookie, userId } = await app.signIn();
    app.sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [userId]);
    const { accessToken } = await oauthAccessToken(app, cookie);
    const files = await generateOrThrow("bun-sqlite", [{ sourceId: "oauth-mcp.yaml", text: `apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: {name: admin-check}
spec: {surface: admin, sql: 'SELECT 1 AS answer'}
` }]);
    const dir = await mkdtemp(resolve(import.meta.dir, ".oauth-mcp-"));
    try {
      await writeGenerated(dir, files);
      const { mcp } = await import(resolve(dir, "mcp.ts"));
      const handle = mcp({ db: () => app.sqlite, caller: (request: Request) => resolveCaller(request, app.loader, { audience: AUDIENCE }) });
      const call = async (method: string, params = {}) => {
        const response = await handle(new Request(`${app.origin}/mcp/admin`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), {});
        expect(response.status).toBe(200);
        const text = await response.text();
        return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text);
      };
      expect((await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "oauth-regression", version: "1" } })).result.protocolVersion).toBe("2025-03-26");
      expect((await call("tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["admin_check"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("9. real access token -> oauth user caller; role re-read; wrong audience / garbage / banned / no audience option -> UNAUTHENTICATED", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const { accessToken, clientId } = await oauthAccessToken(app, cookie);
    expect(accessToken.split(".")).toHaveLength(3);

    const caller = await resolveCaller(bearer(app, accessToken), app.loader, { audience: AUDIENCE });
    expect(caller).toMatchObject({ kind: "user", subject: userId, role: "user", admin: false, scopes: ["mcp"], credential: "oauth", clientId, issuer: expect.any(String) });
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
  test("a refresh claim rechecks the exact source row after concurrent revocation", async () => {
    const models: string[] = [];
    const accessToken = oauthGrantExtension.claims!.accessToken!;
    const ctx = {
      body: { refresh_token: "source-token" },
      error: (_status: string, body: object) => Object.assign(new Error("invalid grant"), body),
      context: { adapter: { findOne: async ({ model }: { model: string }) => { models.push(model); return { userId: "u", clientId: "c", revoked: new Date() }; } } },
    };
    await expect(accessToken({ ctx, opts: {}, user: { id: "u" }, client: { clientId: "c" }, scopes: ["offline_access"], grantType: "refresh_token" } as never)).rejects.toMatchObject({ error: "invalid_grant" });
    expect(models).toEqual(["oauthRefreshToken"]);
  });
  test("revoke rejects issued JWT and does not resurrect it on reconsent", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const { accessToken, clientId } = await oauthAccessToken(app, cookie);
    const request = app.request({ authorization: `Bearer ${accessToken}` });
    expect(await resolveCaller(request, app.loader, { audience: AUDIENCE, scopes: ["mcp"] })).toMatchObject({ subject: userId });
    await expect(resolveCaller(request, app.loader, { audience: AUDIENCE, scopes: ["other"] })).rejects.toMatchObject({ code: "AUTH_DENIED" });
    const consents = oauthConsents(app.auth as unknown as AuthInstance & { handler(request: Request): Promise<Response> });
    const [consent] = await consents.listOAuthConsents(userId);
    expect(consent!.clientId).toBe(clientId);
    app.sqlite.run('UPDATE oauthConsent SET referenceId = ? WHERE id = ?', ["other-reference", consent!.id]);
    await expect(resolveCaller(request, app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    app.sqlite.run('UPDATE oauthConsent SET referenceId = NULL WHERE id = ?', [consent!.id]);
    expect(await consents.revokeOAuthConsent("someone-else", consent!.id)).toBe(false);
    expect(await consents.revokeOAuthConsent(userId, consent!.id)).toBe(true);
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
  test("offline_access outlives the browser session until its refresh lineage ends; session-bound refresh fails coherently", async () => {
    const app = await makeApp(); const { cookie, userId } = await app.signIn();
    const url = app.request().url;
    expect((await oauthAccessToken(app, cookie)).refreshToken).toBeUndefined();
    const { accessToken, refreshToken, clientId } = await oauthAccessToken(app, cookie, "mcp offline_access");
    const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { scope: string; sid?: string };
    expect(claims(accessToken).scope).toBe("mcp offline_access");
    const use = (token: string) => resolveCaller(new Request(url, { headers: { authorization: `Bearer ${token}` } }), app.loader, { audience: AUDIENCE });
    const refresh = async (token: string, scope?: string) => {
      const response = await fetch(`${app.baseURL}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId, resource: AUDIENCE, ...(scope ? { scope } : {}) }) });
      return { status: response.status, body: await response.json() as { access_token: string; refresh_token: string; error?: string } };
    };
    app.sqlite.run("UPDATE session SET expiresAt = ? WHERE userId = ?", [new Date(0).toISOString(), userId]);
    expect(await use(accessToken)).toMatchObject({ subject: userId, credential: "oauth" });
    const expired = await refresh(refreshToken!);
    expect(expired.status).toBe(200);
    expect(claims(expired.body.access_token).sid).toBeString();
    expect(await use(expired.body.access_token)).toMatchObject({ subject: userId });
    expect(await refresh(expired.body.refresh_token, "mcp")).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    app.sqlite.run("DELETE FROM session WHERE userId = ?", [userId]);
    const deleted = await refresh(expired.body.refresh_token);
    expect(deleted.status).toBe(200);
    expect(claims(deleted.body.access_token).sid).toBeNull();
    expect(await use(deleted.body.access_token)).toMatchObject({ subject: userId });
    expect(await use(expired.body.access_token)).toMatchObject({ subject: userId });
    app.sqlite.run("UPDATE user SET banned = 1 WHERE id = ?", [userId]);
    await expect(use(deleted.body.access_token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    app.sqlite.run("UPDATE user SET banned = 0 WHERE id = ?", [userId]);
    expect(await use(deleted.body.access_token)).toMatchObject({ subject: userId });
    app.sqlite.run("UPDATE oauthRefreshToken SET expiresAt = ? WHERE revoked IS NULL", [new Date(0).toISOString()]);
    await expect(use(deleted.body.access_token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    app.sqlite.run("UPDATE oauthRefreshToken SET expiresAt = ? WHERE revoked IS NULL", [new Date(Date.now() + 60_000).toISOString()]);
    expect(await use(deleted.body.access_token)).toMatchObject({ subject: userId });
    const consent = (await oauthConsents(app.auth as never).listOAuthConsents(userId)).find(x => x.clientId === clientId);
    expect(await oauthConsents(app.auth as never).revokeOAuthConsent(userId, consent!.id)).toBe(true);
    await expect(use(deleted.body.access_token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await refresh(deleted.body.refresh_token)).status).toBe(400);
  });
  test("password resets, admin bans, session revocation and password changes end a user's grants for good", async () => {
    const app = await makeApp(), root = await app.signIn("root@example.test");
    app.sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [root.userId]);
    const asAdmin = (path: string, body: object) => app.post(path, body, { cookie: root.cookie });
    const use = (token: string) => resolveCaller(app.request({ authorization: `Bearer ${token}` }), app.loader, { audience: AUDIENCE });
    const refresh = (grant: { refreshToken?: string; clientId: string }) => fetch(`${app.baseURL}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refreshToken!, client_id: grant.clientId, resource: AUDIENCE }) });
    const session = async (cookie: string) => !!await app.auth.api.getSession({ headers: new Headers({ cookie }) });
    const resetLink = async (email: string) => { await app.post("/request-password-reset", { email, redirectTo: "/" }); return app.resets.at(-1)!; };
    const resetOtp = async (email: string) => { await app.post("/email-otp/request-password-reset", { email }); return app.otps.findLast(x => x.email === email)!.otp; };
    const password = "another-password-123", cookieOf = (response: Response) => response.headers.getSetCookie().map(line => line.split(";")[0]).join("; ");
    const signUp = async (email: string) => { const response = await app.post("/sign-up/email", { email, password: "first-password-123", name: email }); return { cookie: cookieOf(response), userId: (await response.json() as { user: { id: string } }).user.id }; };
    type End = (user: { userId: string; email: string; cookie: string }) => Promise<Response>;
    const events: [string, End][] = [
      ["reset", async ({ email }) => app.post("/reset-password", { newPassword: password, token: await resetLink(email) })],
      ["query", async ({ email }) => app.post(`/reset-password?token=${await resetLink(email)}`, { newPassword: password })],
      ["email-otp", async ({ email }) => app.post("/email-otp/reset-password", { email, otp: await resetOtp(email), password })],
      ["phone", async ({ userId }) => {
        const phone = `+1555${userId.slice(0, 7)}`;
        app.sqlite.run("UPDATE user SET phoneNumber = ? WHERE id = ?", [phone, userId]);
        await app.post("/phone-number/request-password-reset", { phoneNumber: phone });
        return app.post("/phone-number/reset-password", { phoneNumber: phone, otp: app.phoneOtps.at(-1), newPassword: password });
      }],
      ["password", ({ userId }) => asAdmin("/admin/set-user-password", { userId, newPassword: password })],
      ["ban", ({ userId }) => asAdmin("/admin/ban-user", { userId })],
      ["update-ban", ({ userId }) => asAdmin("/admin/update-user", { userId, data: { banned: true } })],
      ["sessions", ({ userId }) => asAdmin("/admin/revoke-user-sessions", { userId })],
      ["change", ({ cookie }) => app.post("/change-password", { currentPassword: "first-password-123", newPassword: password, revokeOtherSessions: true }, { cookie })],
    ];
    for (const [name, end] of events) {
      const email = `${name}@example.test`;
      const { cookie, userId } = name === "change" ? await signUp(email) : await app.signIn(email);
      // An email OTP sign-in verifies the signed-up email, which ends that user's earlier sessions.
      const other = name === "change" ? cookieOf(await app.post("/sign-in/email", { email, password: "first-password-123" })) : (await app.signIn(email)).cookie;
      const grant = await oauthAccessToken(app, cookie, "mcp offline_access");
      // Consent exists, so this code is issued silently; it stays unredeemed across the event.
      const pending = await authorize(app, cookie, grant.clientId, "mcp offline_access");
      expect(pending.location, name).toStartWith(REDIRECT);
      // Redeeming would fail anyway once the code's session is gone, so check the row itself.
      const codes = () => app.sqlite.query("SELECT count(*) AS n FROM verification WHERE value LIKE ? AND value LIKE '%authorization_code%'").get(`%${userId}%`);
      expect(codes(), name).toEqual({ n: 1 });
      const ended = await end({ userId, email, cookie });
      expect(ended.status, name).toBe(200);
      // Better Auth replaces the current session of a password change with a new one; every other session ends.
      const current = name === "change" ? cookieOf(ended) : null;
      if (name.endsWith("ban")) expect((await asAdmin("/admin/unban-user", { userId })).status).toBe(200);
      expect((await refresh(grant)).status, name).not.toBe(200);
      expect(codes(), name).toEqual({ n: 0 });
      expect((await exchange(app, grant.clientId, new URL(pending.location).searchParams.get("code")!, pending.verifier)).status, name).not.toBe(200);
      await expect(use(grant.accessToken), name).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect([await session(cookie), await session(other), !!current && await session(current)], name).toEqual([false, false, name === "change"]);
      // No silent re-grant: the next authorization for that client asks again.
      const again = current ?? (await app.signIn(email)).cookie;
      expect((await authorize(app, again, grant.clientId, "mcp offline_access")).location, name).toContain("/oauth/consent?");
    }
    // Failed resets, a non-ban update, sign-out, signing out everywhere and a password change that keeps other devices end nothing.
    const keeps: [string, End][] = [
      ["short-reset", async ({ email }) => app.post("/reset-password", { newPassword: "short", token: await resetLink(email) })],
      ["short-otp", async ({ email }) => app.post("/email-otp/reset-password", { email, otp: await resetOtp(email), password: "short" })],
      ["rename", ({ userId }) => asAdmin("/admin/update-user", { userId, data: { name: "renamed" } })],
      ["sign-out", ({ cookie }) => app.post("/sign-out", {}, { cookie })],
      ["revoke-sessions", ({ cookie }) => app.post("/revoke-sessions", {}, { cookie })],
      ["revoke-other-sessions", ({ cookie }) => app.post("/revoke-other-sessions", {}, { cookie })],
      ["keep-change", ({ cookie }) => app.post("/change-password", { currentPassword: "first-password-123", newPassword: password }, { cookie })],
    ];
    for (const [name, end] of keeps) {
      const email = `${name}@example.test`, { cookie, userId } = name === "keep-change" ? await signUp(email) : await app.signIn(email);
      const grant = await oauthAccessToken(app, cookie, "mcp offline_access");
      expect((await end({ userId, email, cookie })).status, name).toBe(name.startsWith("short") ? 400 : 200);
      expect((await refresh(grant)).status, name).toBe(200);
      app.sqlite.run("DELETE FROM session WHERE userId = ?", [userId]);
      expect(await use(grant.accessToken), name).toMatchObject({ subject: userId });
      // keep-change signed up unverified: an email OTP sign-in would prove the address and end its grants (next test).
      const again = name === "keep-change" ? cookieOf(await app.post("/sign-in/email", { email, password })) : (await app.signIn(email)).cookie;
      expect((await authorize(app, again, grant.clientId, "mcp offline_access")).location, name).toStartWith(REDIRECT);
    }
  }, 30_000); // Real password hashing and all grant-ending paths also run under parallel workspace load.
  test("an email OTP or magic-link sign-in that proves an unverified address ends the grants of whoever signed it up first", async () => {
    for (const store of ["plain", "hashed"] as const) {
      const app = await makeApp({ magicLinkStore: store });
      const cookieOf = (response: Response) => response.headers.getSetCookie().map(line => line.split(";")[0]).join("; ");
      const use = (token: string) => resolveCaller(app.request({ authorization: `Bearer ${token}` }), app.loader, { audience: AUDIENCE });
      const refresh = (grant: { refreshToken?: string; clientId: string }) => fetch(`${app.baseURL}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refreshToken!, client_id: grant.clientId, resource: AUDIENCE }) });
      const link = async (email: string, callback: string) => {
        expect((await app.post("/sign-in/magic-link", { email })).status).toBe(200);
        return app.auth.handler(new Request(`${app.baseURL}/magic-link/verify?token=${app.links.at(-1)}${callback}`, { headers: { origin: app.origin } }));
      };
      const proofs: [string, (email: string) => Promise<Response>][] = [
        ["otp", async email => { await app.post("/email-otp/send-verification-otp", { email, type: "sign-in" }); return app.post("/sign-in/email-otp", { email, otp: app.otps.findLast(x => x.email === email)!.otp }); }],
        ["link", email => link(email, "")],
        ["link-redirect", email => link(email, "&callbackURL=%2Fhome")],
      ];
      for (const [kind, prove] of proofs) {
        const name = `${store}-${kind}`, email = `${name}@example.test`;
        // The attacker registers the owner's address first (unverified) and connects their own client.
        const signedUp = await app.post("/sign-up/email", { email, password: "attacker-password-1", name: "attacker" });
        expect(signedUp.status, name).toBe(200);
        const attacker = cookieOf(signedUp), userId = (await signedUp.json() as { user: { id: string } }).user.id;
        const grant = await oauthAccessToken(app, attacker, "mcp offline_access");
        const pending = await authorize(app, attacker, grant.clientId, "mcp offline_access");
        expect(pending.location, name).toStartWith(REDIRECT);
        const proved = await prove(email);
        expect(proved.status, name).toBe(kind === "link-redirect" ? 302 : 200);
        expect(app.sqlite.query("SELECT emailVerified AS v FROM user WHERE id = ?").get(userId), name).toEqual({ v: 1 });
        expect((await refresh(grant)).status, name).not.toBe(200);
        expect(app.sqlite.query("SELECT count(*) AS n FROM oauthConsent WHERE userId = ?").get(userId), name).toEqual({ n: 0 });
        expect((await exchange(app, grant.clientId, new URL(pending.location).searchParams.get("code")!, pending.verifier)).status, name).not.toBe(200);
        await expect(use(grant.accessToken), name).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
        // The owner's own session works and their next grant survives a later sign-in of the now verified address.
        const owner = cookieOf(proved);
        expect(await app.auth.api.getSession({ headers: new Headers({ cookie: owner }) }), name).toMatchObject({ user: { id: userId } });
        const own = await oauthAccessToken(app, owner, "mcp offline_access");
        expect((await prove(email)).status, name).toBe(kind === "link-redirect" ? 302 : 200);
        expect((await refresh(own)).status, name).toBe(200);
      }
    }
  });
  test("a proof whose grant ending fails leaves the user unverified, so the retry still ends the pre-registrant's grants", async () => {
    const app = await makeApp();
    const cookieOf = (response: Response) => response.headers.getSetCookie().map(line => line.split(";")[0]).join("; ");
    const refresh = (grant: { refreshToken?: string; clientId: string }) => fetch(`${app.baseURL}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refreshToken!, client_id: grant.clientId, resource: AUDIENCE }) });
    const proofs: [string, (email: string) => Promise<Response>][] = [
      ["otp", async email => { await app.post("/email-otp/send-verification-otp", { email, type: "sign-in" }); return app.post("/sign-in/email-otp", { email, otp: app.otps.findLast(x => x.email === email)!.otp }); }],
      ["link", async email => { await app.post("/sign-in/magic-link", { email }); return app.auth.handler(new Request(`${app.baseURL}/magic-link/verify?token=${app.links.at(-1)}`, { headers: { origin: app.origin } })); }],
    ];
    for (const [kind, prove] of proofs) {
      const email = `retry-${kind}@example.test`, signedUp = await app.post("/sign-up/email", { email, password: "attacker-password-1", name: "attacker" });
      const userId = (await signedUp.json() as { user: { id: string } }).user.id, grant = await oauthAccessToken(app, cookieOf(signedUp), "mcp offline_access");
      app.sqlite.run("CREATE TRIGGER fail_consent BEFORE DELETE ON oauthConsent BEGIN SELECT RAISE(ABORT, 'consent delete failed'); END");
      expect((await prove(email)).status, kind).toBeGreaterThanOrEqual(500);
      app.sqlite.run("DROP TRIGGER fail_consent");
      expect(app.sqlite.query("SELECT emailVerified AS v FROM user WHERE id = ?").get(userId), kind).toEqual({ v: 0 });
      expect((await prove(email)).status, kind).toBe(200);
      expect(app.sqlite.query("SELECT emailVerified AS v FROM user WHERE id = ?").get(userId), kind).toEqual({ v: 1 });
      expect(app.sqlite.query("SELECT count(*) AS n FROM oauthConsent WHERE userId = ?").get(userId), kind).toEqual({ n: 0 });
      expect((await refresh(grant)).status, kind).not.toBe(200);
    }
  });
  test("a reset ends sessions before grants, so a failure in between cannot leave the old sessions alive", async () => {
    const app = await makeApp(), { cookie, userId } = await app.signIn("order@example.test");
    await oauthAccessToken(app, cookie, "mcp offline_access");
    app.sqlite.run("CREATE TRIGGER fail_consent BEFORE DELETE ON oauthConsent BEGIN SELECT RAISE(ABORT, 'consent delete failed'); END");
    await app.post("/request-password-reset", { email: "order@example.test", redirectTo: "/" });
    expect((await app.post("/reset-password", { newPassword: "another-password-123", token: app.resets.at(-1) })).status).toBeGreaterThanOrEqual(500);
    expect(app.sqlite.query("SELECT count(*) AS n FROM session WHERE userId = ?").get(userId)).toEqual({ n: 0 });
  });
  test("sign-out follows Better Auth: session-bound grants end, offline_access refresh tokens survive", async () => {
    const app = await makeApp(); const { cookie, userId } = await app.signIn();
    const online = await oauthAccessToken(app, cookie), offline = await oauthAccessToken(app, cookie, "mcp offline_access");
    expect((await app.post("/sign-out", {}, { cookie })).status).toBe(200);
    const use = (token: string) => resolveCaller(app.request({ authorization: `Bearer ${token}` }), app.loader, { audience: AUDIENCE });
    await expect(use(online.accessToken)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const response = await fetch(`${app.baseURL}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: offline.refreshToken!, client_id: offline.clientId, resource: AUDIENCE }) });
    expect(response.status).toBe(200);
    expect(await use((await response.json() as { access_token: string }).access_token)).toMatchObject({ subject: userId });
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
    const app = await makeApp({ localOnly: true }); const { cookie } = await app.signIn();
    const origin = new URL(app.baseURL).origin;
    const routes = authRoutes(app.loader as never, { methods: [] });
    expect((await routes(new Request(`${origin}/oauth/consent/data`, { headers: { cookie } })))!.status).toBe(400);
    expect((await routes(new Request(`${origin}/oauth/consent`, { method: "POST", headers: { cookie, origin }, body: "decision=other" })))!.status).toBe(400);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); controller.close(); } });
    const response = await routes(new Request(`${origin}/oauth/consents/revoke`, { method: "POST", headers: { cookie, origin }, body: stream, duplex: "half" } as RequestInit));
    expect(response!.status).toBe(400); expect(response!.headers.get("cache-control")).toContain("no-store");
    const raw = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); controller.close(); } });
    expect((await routes(new Request(`${app.baseURL}/email-otp/send-verification-otp`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: raw, duplex: "half" } as RequestInit)))!.status).toBe(400);
    expect(() => authRoutes(app.loader as never, { methods: [], connectedAppsPage: "/\\evil.test" })).toThrow("same-origin");
  });
  test("a refused consent POST leaves no unread body", async () => {
    const app = await makeApp(); const origin = new URL(app.baseURL).origin;
    const request = new Request(`${origin}/oauth/consent`, { method: "POST", headers: { origin }, body: "decision=approve" });
    expect((await authRoutes(app.loader as never, { methods: [] })(request))!.status).toBe(401);
    expect(request.bodyUsed).toBe(true);
  });
  test("raw and encoded SDK admin routes ignore stale admin KV after demotion, ban or session deletion", async () => {
    const app = await makeApp({ sessionCache: true, customAdmin: true });
    const signed = await app.signIn();
    app.sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [signed.userId]);
    const { cookie } = await app.signIn();
    const routes = authRoutes(app.loader as never, { methods: [] });
    const call = (path = "/admin/list-users") => routes(new Request(`${app.baseURL}${path}?limit=1`, { headers: { cookie } }));
    expect((await call())!.status).toBe(200);
    app.breakCache();
    app.sqlite.run("UPDATE user SET role = 'user' WHERE id = ?", [signed.userId]);
    // The exact SDK API still trusts its cached admin snapshot; our public HTTP boundary must not.
    expect(((await app.auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } }))!.user as { role?: string }).role).toBe("admin");
    expect((await call())!.status).toBe(403);
    expect((await call("/%61dmin/list-users"))!.status).toBe(403);
    app.sqlite.run("UPDATE user SET role = 'admin', banned = 1 WHERE id = ?", [signed.userId]);
    expect((await call())!.status).toBe(401);
    app.sqlite.run("UPDATE user SET banned = 0 WHERE id = ?", [signed.userId]);
    const hostile = await routes(new Request(`${app.baseURL}/%61dmin/set-role`, { method: "POST", headers: { cookie, origin: "https://evil.test", "content-type": "application/json" }, body: "{}" }));
    expect(hostile!.status).toBe(403); expect((await hostile!.json() as { error: { path: string } }).error.path).toBe("request:origin");
    app.sqlite.run("DELETE FROM session WHERE userId = ?", [signed.userId]);
    expect((await call())!.status).toBe(401);
    expect((await call("/%61dmin/list-users"))!.status).toBe(401);
  });
  test("raw SDK admin routes reject cached role drift within the admin layer", async () => {
    let handled = 0;
    const fresh = fixtureCaller({ kind: "user", subject: "u", role: "support", admin: true, scopes: [], credential: "session", credentialId: "s", clientId: null });
    const auth = {
      options: { secondaryStorage: {}, plugins: [{ id: "admin", options: { adminRoles: ["owner", "support"] } }] },
      $context: Promise.resolve({}),
      api: { getSession: async () => ({ headers: null, response: { session: { id: "s" }, user: { id: "u", role: "owner" } } }) },
      handler: async () => { handled++; return new Response("handled"); },
    };
    const routes = authRoutes({ cookiePrefix: "better-auth", get: async () => auth } as never, { methods: [], resolver: () => fresh });
    const response = await routes(new Request("https://service.test/api/auth/admin/list-users", { headers: { origin: "https://service.test" } }));
    expect(response!.status).toBe(403); expect(handled).toBe(0);
  });
  test("an expired primary session cannot refresh from a still-valid KV snapshot", async () => {
    const app = await makeApp({ sessionCache: true, customAdmin: true });
    const signed = await app.signIn(); app.sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [signed.userId]);
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
  test("bearer authority checks the live grant and current user; connected apps is one JOIN in updated order", async () => {
    const app = await makeApp(); const { cookie, userId } = await app.signIn();
    const { accessToken } = await oauthAccessToken(app, cookie);
    app.statements.length = 0;
    expect(await resolveCaller(app.request({ authorization: `Bearer ${accessToken}` }), app.loader, { audience: AUDIENCE })).toMatchObject({ subject: userId });
    expect(app.statements.filter(sql => sql.includes('LEFT JOIN "oauthConsent"'))).toHaveLength(1);
    expect(app.statements.some(sql => sql.includes('JOIN "session"'))).toBe(true);
    expect(app.statements.some(sql => /FROM "user"/.test(sql))).toBe(true);
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
    const app = await makeApp(); const { cookie, userId } = await app.signIn();
    const credential = fixtureCaller({ kind: "user", subject: userId, role: null, scopes: ["mcp"], credential: "api-key", credentialId: "key-id", clientId: null } as const);
    expect(await resolveCaller(app.request({ cookie, authorization: "Bearer invalid" }), app.loader, { scopes: ["mcp"], resolveCredential: () => credential })).toEqual({ ...credential, role: "user", roles: ["user"], admin: false });
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

describe("verified user field sources", () => {
  const fields = { region: { type: "string", multiple: true } } as const;
  test("session and test callers carry generated fields into a scoped View; copies are denied", async () => {
    const app = await makeApp({ localOnly: true, additionalFields: { region: { type: "string[]", required: false, input: false } } });
    const { cookie, userId } = await app.signIn();
    await expect(app.auth.api.updateUser({ headers: new Headers({ cookie }), body: { region: { all: true } } as never })).rejects.toThrow("region is not allowed");
    const { internalAdapter } = await app.auth.$context;
    expect((await internalAdapter.findUserById(userId) as Record<string, unknown>).region).toBeNull();
    await internalAdapter.updateUser(userId, { region: ['TW'] } as never);
    const manifests = [
      { apiVersion: 'cms.mantle.aotter.net/v2', kind: 'Schema', metadata: { name: 'orders' }, spec: { title: 'Orders', scope: "region IN auth.user('region')", schema: { type: 'object', required: ['region'], properties: { region: { type: 'string' } } }, indexes: [['region', 'id']] } },
      { apiVersion: 'cms.mantle.aotter.net/v2', kind: 'View', metadata: { name: 'orders' }, spec: { surface: 'internal', sql: 'SELECT id, region FROM orders ORDER BY id' } },
    ];
    const files = await generateOrThrow('bun-sqlite', [{ sourceId: 'fields.yaml', text: manifests.map(m => JSON.stringify(m)).join('\n---\n') }]);
    await mkdir(resolve(import.meta.dir, 'apps/.generated'), { recursive: true });
    const dir = await mkdtemp(resolve(import.meta.dir, 'apps/.generated/auth-fields-'));
    try {
      await writeGenerated(dir, files);
      const generated = await import(resolve(dir, 'generated.ts'));
      expect(generated.userFields).toEqual(fields);
      app.sqlite.exec(files['schema.sql']!);
      for (const region of ['TW', 'JP']) await generated.store(app.sqlite, { kind: 'system', reason: 'fixture' }).collection('orders').insert({ region });
      const caller = await resolveCaller(app.request({ cookie }), app.loader, { fields: generated.userFields });
      expect(fieldsOf(caller)).toEqual({ region: ['TW'] });
      const testCaller = authenticatedAs({ id: userId, region: ['TW'] }, { fields: generated.userFields });
      for (const original of [caller, testCaller]) {
        expect((await generated.views.orders(app.sqlite, original, {})).map((row: { region: string }) => row.region)).toEqual(['TW']);
        await expect(generated.views.orders(app.sqlite, { ...original }, {})).rejects.toMatchObject({ code: 'AUTH_DENIED' });
      }
      const service = authenticatedAs({ id: userId, region: { all: true } }, { fields, credential: 'api-key' });
      expect(fieldsOf(await resolveCaller(app.request(), app.loader, { fields, resolveCredential: () => service }))).toEqual({ region: ['TW'] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("unsafe and missing sources fail before session resolution, even with customSession", async () => {
    for (const input of [true, undefined, 'missing'] as const) {
      const app = await makeApp({ localOnly: true, additionalFields: input === 'missing' ? undefined : { region: { type: 'string', required: false, ...(input === true ? { input } : {}) } }, derivedRegion: input === true });
      const { cookie } = await app.signIn();
      for (let i = 0; i < 2; i++) {
        const error = await resolveCaller(app.request({ cookie }), app.loader, { fields }).catch(error => error);
        expect(error.code).toBe('AUTH_CONFIGURATION_ERROR');
        expect(error.message).toContain("'region'");
      }
    }
  });
  test("customSession supplies server-derived fields", async () => {
    for (const sessionCache of [false, true]) {
      const app = await makeApp({ localOnly: true, derivedRegion: true, sessionCache });
      const { cookie } = await app.signIn();
      expect(fieldsOf(await resolveCaller(app.request({ cookie }), app.loader, { fields }))).toEqual({ region: ['TW'] });
      const service = authenticatedAs({ id: (await app.auth.api.getSession({ headers: new Headers({ cookie }) }))!.user.id }, { credential: 'api-key' });
      for (const requestOptions of [{ resolveCredential: () => service }, { audience: AUDIENCE }]) {
        await expect(resolveCaller(app.request({ authorization: 'Bearer unused' }), app.loader, { fields, ...requestOptions })).rejects.toMatchObject({ code: 'AUTH_CONFIGURATION_ERROR', message: expect.stringContaining('customSession-only') });
      }
    }
  });
});

test("all credentials load the same current roles, ban and JSON user fields", async () => {
  const fields = { region: { type: "string", multiple: true } } as const;
  const app = await makeApp({ additionalFields: { region: { type: "json", required: false, input: false } } });
  const { cookie, userId } = await app.signIn();
  const { internalAdapter } = await app.auth.$context;
  await internalAdapter.updateUser(userId, { role: "admin,editor", region: { all: true } } as never);
  const { accessToken } = await oauthAccessToken(app, cookie);
  const service = authenticatedAs({ id: userId, role: "admin", region: ["JP"] }, { fields, credential: "api-key" });
  const resolve = (withFields = true) => Promise.all([
    resolveCaller(app.request({ cookie }), app.loader, { fields: withFields ? fields : undefined }),
    resolveCaller(app.request({ authorization: `Bearer ${accessToken}` }), app.loader, { audience: AUDIENCE, fields: withFields ? fields : undefined }),
    resolveCaller(app.request(), app.loader, { fields: withFields ? fields : undefined, resolveCredential: () => service }),
  ]);
  for (const caller of await resolve()) {
    expect(rolesOf(caller)).toEqual(["admin", "editor"]);
    expect(fieldsOf(caller)).toEqual({ region: { all: true } });
  }
  app.sqlite.run('UPDATE user SET role = ?, region = ? WHERE id = ?', ["editor", JSON.stringify(["TW"]), userId]);
  for (const caller of await resolve()) {
    expect(caller).toMatchObject({ admin: false, role: "editor" });
    expect(fieldsOf(caller)).toEqual({ region: ["TW"] });
  }
  expect((await resolve(false))[2]).toMatchObject({ admin: false, role: "editor" });
  await internalAdapter.updateUser(userId, { banned: true } as never);
  expect(await resolveCaller(app.request({ cookie }), app.loader)).toEqual({ kind: "anonymous" });
  await expect(resolveCaller(app.request(), app.loader, { resolveCredential: () => service })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  await expect(resolveCaller(app.request({ authorization: `Bearer ${accessToken}` }), app.loader, { audience: AUDIENCE })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});

test("impersonated sessions carry a real actor only on the branded identity", async () => {
  const app = await makeApp({ localOnly: true });
  const actor = await app.signIn("admin@example.test"), member = await app.signIn();
  await (await app.auth.$context).internalAdapter.updateUser(actor.userId, { role: "admin" } as never);
  const result = await app.auth.api.impersonateUser({ headers: new Headers({ cookie: actor.cookie }), body: { userId: member.userId }, returnHeaders: true });
  const cookies = new Map(result.headers.getSetCookie().map(line => { const pair = line.split(";")[0]!; const index = pair.indexOf("="); return [pair.slice(0, index), pair.slice(index + 1)] as const; }));
  const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  const caller = await resolveCaller(app.request({ cookie }), app.loader);
  expect(caller).toMatchObject({ subject: member.userId, impersonatedBy: actor.userId });
  expect("impersonatedBy" in { ...caller }).toBe(false);
  expect(Object.create(caller).impersonatedBy).toBeUndefined();
  expect(Object.isFrozen(caller)).toBe(true);
});

test("first-party skip_consent tokens require live client scopes and a live session", async () => {
  const app = await makeApp(); const { cookie, userId } = await app.signIn();
  const { accessToken, clientId } = await oauthAccessToken(app, cookie, "mcp", undefined, true);
  const request = app.request({ authorization: `Bearer ${accessToken}` });
  const caller = () => resolveCaller(request, app.loader, { audience: AUDIENCE });
  expect(await caller()).toMatchObject({ subject: userId, credential: "oauth" });
  app.sqlite.run('UPDATE oauthClient SET scopes = ? WHERE clientId = ?', ['[]', clientId]);
  await expect(caller()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  app.sqlite.run('UPDATE oauthClient SET scopes = ?, skipConsent = 0 WHERE clientId = ?', ['["mcp"]', clientId]);
  await expect(caller()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  app.sqlite.run('UPDATE oauthClient SET skipConsent = 1 WHERE clientId = ?', [clientId]);
  expect(await caller()).toMatchObject({ subject: userId });
  app.sqlite.run('DELETE FROM session WHERE userId = ?', [userId]);
  await expect(caller()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});
