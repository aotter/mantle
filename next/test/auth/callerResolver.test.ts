import { describe, expect, it, vi } from "vitest";
import { createCallerResolver, withCaller, type AuthLike, type OAuthAccessTokenVerification } from "../../src/auth/index.js";

const req = (headers: Record<string, string> = {}) => new Request("https://x/api", { headers });
const auth = (over: Partial<AuthLike> = {}): AuthLike => ({
  getSession: async () => null,
  getUserRole: async () => null,
  verifyOAuthAccessToken: async () => ({ ok: false, status: 401, reason: "invalid-token" }),
  ...over,
});
const okToken: OAuthAccessTokenVerification = { ok: true, userId: "u1", clientId: "c1", credentialId: "jti1", scopes: ["a", "b"] };

describe("createCallerResolver", () => {
  it("no credential is anonymous", async () => {
    expect(await createCallerResolver(auth())(req())).toEqual({ caller: { kind: "anonymous" } });
  });

  it("a cookie session is a user whose staff role is read fresh, and a non-staff string is no role", async () => {
    const getUserRole = vi.fn(async () => "editor");
    const resolve = createCallerResolver(auth({ getSession: async () => ({ session: { id: "s1" }, user: { id: "u1", role: "owner" } }), getUserRole }), { issuer: "https://idp" });
    expect(await resolve(req())).toEqual({ caller: { kind: "user", subject: "u1", issuer: "https://idp", role: "editor", scopes: [], credential: "session", credentialId: "s1", clientId: null } });
    expect(getUserRole).toHaveBeenCalledOnce();
    const stranger = createCallerResolver(auth({ getSession: async () => ({ session: { id: "s" }, user: { id: "u" } }), getUserRole: async () => "superuser" }));
    expect(((await stranger(req())) as { caller: { role: unknown } }).caller.role).toBeNull();
  });

  it("a role that came from the same uncached read is not read again", async () => {
    const getUserRole = vi.fn(async () => "owner");
    const resolve = createCallerResolver(auth({ getSession: async () => ({ session: { id: "s" }, user: { id: "u", role: "contributor", roleCurrent: true } }), getUserRole }));
    expect(((await resolve(req())) as { caller: { role: unknown } }).caller.role).toBe("contributor");
    expect(getUserRole).not.toHaveBeenCalled();
  });

  it("a Bearer or DPoP token is an oauth user with its client and scopes", async () => {
    const verify = vi.fn(async () => okToken);
    const resolve = createCallerResolver(auth({ verifyOAuthAccessToken: verify, getUserRole: async () => "owner" }), { jwtBearer: { audience: "https://mcp", scopes: ["a"] } });
    for (const scheme of ["Bearer", "DPoP"]) {
      expect(await resolve(req({ authorization: `${scheme} tok` }))).toEqual({ caller: { kind: "user", subject: "u1", role: "owner", scopes: ["a", "b"], credential: "oauth", credentialId: "jti1", clientId: "c1" } });
    }
    expect(verify).toHaveBeenCalledWith(expect.any(Request), { audience: "https://mcp", scopes: ["a"] });
  });

  it("a presented credential that fails is invalid, and never falls back to a valid session cookie", async () => {
    const withSession = { getSession: async () => ({ session: { id: "s" }, user: { id: "u" } }) };
    expect(await createCallerResolver(auth(withSession), { jwtBearer: { audience: "a" } })(req({ authorization: "Bearer bad" }))).toEqual({ invalid: true, challenge: 'Bearer error="invalid_token"', status: 401 });
    expect(await createCallerResolver(auth(withSession))(req({ authorization: "Bearer tok" }))).toEqual({ invalid: true, challenge: 'Bearer error="invalid_token"' }); // tokens are not configured
    expect(await createCallerResolver(auth(withSession), { jwtBearer: { audience: "a" } })(req({ authorization: "Basic abc" }))).toMatchObject({ invalid: true });
  });

  it("names the failure in the challenge: a bad DPoP proof, and a missing scope as a 403", async () => {
    const fail = (v: OAuthAccessTokenVerification) => createCallerResolver(auth({ verifyOAuthAccessToken: async () => v }), { jwtBearer: { audience: "a" } });
    expect(await fail({ ok: false, status: 401, reason: "invalid-dpop-proof" })(req({ authorization: "DPoP t" }))).toEqual({ invalid: true, challenge: 'DPoP error="invalid_dpop_proof"', status: 401 });
    expect(await fail({ ok: false, status: 403, reason: "insufficient-scope", missingScopes: ["x", "y"] })(req({ authorization: "Bearer t" }))).toEqual({ invalid: true, challenge: 'Bearer error="insufficient_scope", scope="x y"', status: 403 });
  });

  it("a service's own credential comes first: verified is a user with its own subject, invalid is refused, not-handled falls through", async () => {
    const seen: string[] = [];
    const mk = (r: (q: Request) => ReturnType<NonNullable<Parameters<typeof createCallerResolver>[1]>["credentialResolver"] & object>) => createCallerResolver(auth({ getSession: async () => { seen.push("session"); return null; } }), { credentialResolver: r });
    expect(await mk(() => ({ kind: "verified", credential: { credential: "api-key", credentialId: "k1", subject: "key:k1", scopes: ["read"] } }))(req())).toMatchObject({ caller: { kind: "user", subject: "key:k1", credential: "api-key", scopes: ["read"], clientId: null } });
    expect(await mk(() => ({ kind: "invalid" }))(req())).toEqual({ invalid: true, challenge: 'Bearer error="invalid_token"' });
    expect(await mk(() => ({ kind: "not-handled" }))(req())).toEqual({ caller: { kind: "anonymous" } });
    expect(seen).toEqual(["session"]);
  });
});

describe("withCaller", () => {
  const seen: unknown[] = [];
  const surface = async (_r: Request, caller: unknown) => { seen.push(caller); return new Response("ok"); };
  it("runs the surface for anonymous and users, and answers an invalid credential 401 (403 for a missing scope) with a challenge, before any surface", async () => {
    const good = withCaller(createCallerResolver(auth()), surface as never);
    expect((await good(req())).status).toBe(200);
    expect(seen).toEqual([{ kind: "anonymous" }]);
    const bad = withCaller(createCallerResolver(auth(), { jwtBearer: { audience: "a" } }), surface as never);
    const res = await bad(req({ authorization: "Bearer nope" }));
    expect([res.status, res.headers.get("www-authenticate"), ((await res.json()) as { error: { code: string } }).error.code]).toEqual([401, 'Bearer error="invalid_token"', "UNAUTHENTICATED"]);
    const scoped = withCaller(createCallerResolver(auth({ verifyOAuthAccessToken: async () => ({ ok: false, status: 403, reason: "insufficient-scope", missingScopes: ["w"] }) }), { jwtBearer: { audience: "a" } }), surface as never);
    expect((await scoped(req({ authorization: "Bearer t" }))).status).toBe(403);
    expect(seen).toHaveLength(1); // no surface ran for either refusal
  });
});
