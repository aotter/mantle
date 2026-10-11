/**
 * resolveCaller / authLoader against a REAL Better Auth instance: emailOTP sign-in, admin (role/banned), jwt and
 * oauthProvider, on the native d1Adapter over a bun:sqlite D1 shim. The auth handler is also served over a local HTTP
 * port, because Better Auth's resource client verifies access tokens against the instance's JWKS URL (baseURL + /jwks).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth/minimal";
import { admin, emailOTP, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { ContractError } from "../src/kernel/contracts.js";
import { authLoader, resolveCaller, type AuthInstance } from "../src/auth/caller.js";
import { d1Adapter, type D1Like } from "../src/auth/adapter.js";
import { authSchemaSql } from "../src/auth/schema.js";

function d1Shim(sqlite: Database): D1Like & { batch(statements: { all(): Promise<unknown> }[]): Promise<unknown[]> } {
  const statement = (text: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(text, next),
    all: async () => ({ results: sqlite.query(text).all(...(values as never[])) as Record<string, unknown>[], meta: { changes: (sqlite.query("SELECT changes() AS c").get() as { c: number }).c } }),
  });
  return { prepare: text => statement(text), batch: statements => Promise.all(statements.map(s => s.all())) };
}

const AUDIENCE = "https://api.example.test/mcp";
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => { for (const server of servers) server.stop(true); });

type App = Awaited<ReturnType<typeof makeApp>>;

async function makeApp(options: { cookiePrefix?: string; sessionTokenName?: string } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const otps: { email: string; otp: string }[] = [];
  // Serve the handler first: baseURL (and so the JWKS URL and token issuer) must name the real port.
  let handle: (request: Request) => Promise<Response> = async () => new Response("not ready", { status: 503 });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => handle(request) });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  // baseURL carries the base path: the resource client derives the JWKS URL and the expected issuer from it as-is.
  const baseURL = `${origin}/api/auth`;
  const betterAuthOptions = {
    baseURL,
    secret: "test-secret-test-secret-test-secret-0123456789",
    database: d1Adapter(d1Shim(sqlite)),
    disabledPaths: ["/token"],
    advanced: {
      ...(options.cookiePrefix ? { cookiePrefix: options.cookiePrefix } : {}),
      ...(options.sessionTokenName ? { cookies: { session_token: { name: options.sessionTokenName } } } : {}),
    },
    plugins: [
      emailOTP({ sendVerificationOTP: async ({ email, otp }) => { otps.push({ email, otp }); } }),
      admin(),
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
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
  return { sqlite, auth, loader, post, signIn, request, baseURL, loads: () => loads };
}

/** A loader whose `load` is counted, so "never loaded" is observable. */
function countingLoader(app: App) {
  let calls = 0;
  const loader = authLoader(async () => { calls++; return app.auth as unknown as AuthInstance; }, app.loader.cookiePrefix);
  return { loader, calls: () => calls };
}

describe("resolveCaller: session cookie", () => {
  test("1. no Cookie and no Authorization -> anonymous, the loader is never called", async () => {
    const app = await makeApp();
    const counted = countingLoader(app);
    expect(await resolveCaller(app.request(), counted.loader)).toEqual({ kind: "anonymous" });
    expect(counted.calls()).toBe(0);
  });

  test("2. only unrelated cookies -> anonymous, the loader is never called", async () => {
    const app = await makeApp();
    const counted = countingLoader(app);
    expect(await resolveCaller(app.request({ cookie: "_ga=1; theme=dark" }), counted.loader)).toEqual({ kind: "anonymous" });
    expect(counted.calls()).toBe(0);
  });

  test("3. email OTP sign-in -> user caller with session id and null role", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const sessionId = (app.sqlite.query("SELECT id FROM session WHERE userId = ?").get(userId) as { id: string }).id;
    const caller = await resolveCaller(app.request({ cookie }), app.loader);
    expect(caller).toEqual({ kind: "user", subject: userId, role: null, scopes: [], credential: "session", credentialId: sessionId, clientId: null });
    expect(app.loads()).toBe(1);
  });

  test("4. role is re-read from the database on every request; non-staff roles map to null", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    const role = async () => (await resolveCaller(app.request({ cookie }), app.loader) as { role: unknown }).role;
    expect(await role()).toBeNull();
    app.sqlite.run("UPDATE user SET role = 'editor' WHERE id = ?", [userId]);
    expect(await role()).toBe("editor");
    app.sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [userId]);
    expect(await role()).toBeNull();
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

  test("getSession Set-Cookie refresh does not matter to the Caller: repeated resolves stay stable", async () => {
    const app = await makeApp();
    const { cookie, userId } = await app.signIn();
    for (let i = 0; i < 3; i++) expect(await resolveCaller(app.request({ cookie }), app.loader)).toMatchObject({ kind: "user", subject: userId });
  });
});

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const REDIRECT = "https://client.example.test/callback";

/** The official authorization-code + PKCE flow against the live instance; returns the access token. */
async function oauthAccessToken(app: App, cookie: string, scope = "mcp") {
  const registered = await app.post("/oauth2/register", { client_name: "test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], scope });
  expect(registered.status).toBe(201);
  const client = await registered.json() as { client_id: string };
  app.sqlite.run("UPDATE oauthClient SET skipConsent = 1 WHERE clientId = ?", [client.client_id]);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: AUDIENCE });
  const authorize = await fetch(`${app.baseURL}/oauth2/authorize?${query}`, { headers: { cookie }, redirect: "manual" });
  const location = authorize.headers.get("location") ?? "";
  expect(location).toStartWith(REDIRECT);
  const code = new URL(location).searchParams.get("code")!;
  expect(code).toBeTruthy();
  const exchange = await fetch(`${app.baseURL}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: AUDIENCE }) });
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
    expect(caller).toMatchObject({ kind: "user", subject: userId, role: null, scopes: ["mcp"], credential: "oauth", clientId, issuer: expect.any(String) });
    expect((caller as { credentialId: string | null }).credentialId).toBeTruthy();

    app.sqlite.run("UPDATE user SET role = 'editor' WHERE id = ?", [userId]);
    expect(await resolveCaller(bearer(app, accessToken), app.loader, { audience: AUDIENCE })).toMatchObject({ role: "editor" });
    app.sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [userId]);
    expect(await resolveCaller(bearer(app, accessToken), app.loader, { audience: AUDIENCE })).toMatchObject({ role: null });

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
    expect(await code(resolveCaller(app.request({ cookie, authorization: "Bearer junk" }), app.loader, { audience: AUDIENCE }))).toBe("UNAUTHENTICATED");
  });
});
