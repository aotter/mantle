/** One real Better Auth cookie oracle, shared by SQLite, PostgreSQL and local D1. No credentials leave this fixture. */
import assert from "node:assert/strict";
import type { BetterAuthOptions } from "@better-auth/core";
import { betterAuth } from "better-auth/minimal";
import { oauthProvider } from "@better-auth/oauth-provider";
import { admin, emailOTP, jwt } from "better-auth/plugins";
import { authLoader, resolveCaller, type AuthInstance } from "../src/auth/caller.js";
import { verifyAuthRequestClasses } from "./auth-request-classes.js";
import { verifyOAuthResources } from "./auth-resource-scenarios.js";
import { authSchemaSql } from "../src/infrastructure/authSchema.js";

type Run = (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;
export async function verifyCookieCaller(database: BetterAuthOptions["database"], dialect: "sqlite" | "postgres", run: Run, statements: string[]) {
  const reads = () => statements.filter(text => /^\s*(SELECT|WITH)\b/i.test(text)).length;
  const counts: Record<string, number> = {};
  for (const variant of ["native", "renamed", "secondary", "fallback"] as const) {
    const renamed = variant === "renamed", cached = variant === "secondary";
    const prefix = `cookie_${variant}_`, cache = new Map<string, string>();
    const u = `${prefix}user`, s = `${prefix}session`;
    const field = (name: string) => renamed ? `mapped_${name}` : name;
    const date = (ms: number) => dialect === "postgres" ? new Date(ms) : new Date(ms).toISOString();
    let otp = "";
    let auth: ReturnType<typeof betterAuth>;
    const options: BetterAuthOptions = {
      baseURL: "http://localhost:3000/api/auth", secret: "cookie-fixture-secret-0123456789-0123456789",
      database,
      user: { modelName: u, ...(renamed ? { fields: { name: field("name"), email: field("email"), emailVerified: field("emailVerified"), createdAt: field("createdAt"), updatedAt: field("updatedAt"), image: field("image") } } : {}) },
      session: { modelName: s, cookieCache: { enabled: true, maxAge: 60, refreshCache: false, version: "read-60-v1" }, ...(cached ? { storeSessionInDatabase: true } : {}), ...(renamed ? { fields: { userId: field("userId"), token: field("token"), expiresAt: field("expiresAt"), createdAt: field("createdAt"), updatedAt: field("updatedAt"), ipAddress: field("ipAddress"), userAgent: field("userAgent") } } : {}) },
      account: { modelName: `${prefix}account` }, verification: { modelName: `${prefix}verification`, storeInDatabase: true },
      ...(cached ? { secondaryStorage: { get: async key => cache.get(key) ?? null, set: async (key, value) => { cache.set(key, value); }, delete: async key => { cache.delete(key); }, getAndDelete: async () => { throw Error("verification stays in the primary database"); }, increment: async () => { throw Error("verification stays in the primary database"); } } } : {}),
      advanced: { database: { ...(variant === "fallback" ? { joins: false } : {}) }, cookiePrefix: prefix },
      // Better Auth's admin plugin mutates its shared schema when fields are renamed; reset every field per fixture.
      plugins: [admin({ schema: { user: { fields: { role: field("role"), banned: field("banned"), banReason: field("banReason"), banExpires: field("banExpires") } } } }), emailOTP({ sendVerificationOTP: async value => { otp = value.otp; } }), ...(variant === "native" ? [jwt({ disableSettingJwtHeader: true }), oauthProvider({ loginPage: "/login", consentPage: "/consent", resources: ["http://localhost:3000/mcp"] })] : [])],
    };
    for (const text of authSchemaSql(options, dialect)) await run(text);
    auth = betterAuth(options);
    let loads = 0;
    const loader = authLoader(async () => { loads++; return auth as unknown as AuthInstance; }, prefix);
    const request = (cookie?: string, authorization?: string) => new Request("http://localhost:3000/private", { headers: { ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) } });
    statements.length = 0;
    assert.deepEqual(await resolveCaller(request(), loader), { kind: "anonymous" });
    assert.deepEqual(await resolveCaller(request("unrelated=1"), loader), { kind: "anonymous" });
    assert.equal(loads, 0); assert.equal(statements.length, 0);
    await assert.rejects(resolveCaller(request(undefined, "Basic invalid"), loader), { code: "UNAUTHENTICATED" });
    assert.equal(loads, 0); assert.equal(statements.length, 0);
    const post = (path: string, body: unknown) => auth.handler(new Request(`${options.baseURL}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
    assert.equal((await post("/email-otp/send-verification-otp", { email: `${variant}@example.test`, type: "sign-in" })).status, 200);
    const signed = await post("/sign-in/email-otp", { email: `${variant}@example.test`, otp });
    assert.equal(signed.status, 200);
    const cookie = signed.headers.getSetCookie().map(line => line.split(";")[0]).join("; ");
    const { user: { id } } = await signed.json() as { user: { id: string } };
    const check = async (name: string, expected: number, responseHeaders?: Headers) => {
      statements.length = 0;
      const caller = await resolveCaller(request(cookie), loader, { responseHeaders });
      assert.equal(reads(), expected, `${variant}/${name}: ${statements.join("\n")}`);
      counts[`${variant}:${name}`] = reads();
      return { caller, responseHeaders: responseHeaders ?? new Headers() };
    };
    const expected = (cached ? 1 : variant === "fallback" ? 2 : 1) + 1;
    assert.equal((await check("fresh", expected)).caller.kind, "user");
    const readSnapshot = async (name: string, suppliedCookie = cookie, expectedReads = cached ? expected : 1, freshLoader = loader) => {
      statements.length = 0;
      const caller = await resolveCaller(request(suppliedCookie), freshLoader, { readOnly: true });
      assert.equal(reads(), expectedReads, `${variant}/${name}: ${statements.join("\n")}`);
      counts[`${variant}:${name}`] = reads();
      assert.equal(statements.some(text => /^UPDATE /i.test(text)), false);
      return caller;
    };
    assert.equal((await readSnapshot("read-first", cookie, cached ? expected : 1, authLoader(async () => auth as unknown as AuthInstance, prefix))).kind, "user");
    assert.equal((await readSnapshot("read-warm")).kind, "user");
    if (!cached) {
      const withoutCache = cookie.split("; ").filter(value => !value.split("=")[0]!.includes("session_data")).join("; ");
      assert.equal((await readSnapshot("read-no-cache", withoutCache, expected)).kind, "user");
      const tampered = cookie.split("; ").map(value => {
        const index = value.indexOf("="); if (!value.slice(0, index).includes("session_data")) return value;
        const payload = JSON.parse(atob(value.slice(index + 1).replaceAll("-", "+").replaceAll("_", "/")));
        payload.session.user.role = "tampered-admin";
        return value.slice(0, index + 1) + btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      }).join("; ");
      assert.equal((await readSnapshot("read-tampered", tampered, expected)).kind, "user");
      const now = Date.now;
      try { Date.now = () => now() + 61_000; assert.equal((await readSnapshot("read-expired-60s", cookie, expected)).kind, "user"); }
      finally { Date.now = now; }
      options.session!.cookieCache!.maxAge = 61;
      assert.equal((await readSnapshot("read-too-long-config", cookie, expected)).kind, "user");
      options.session!.cookieCache!.maxAge = 60;
      options.session!.cookieCache!.version = "read-60-v2";
      assert.equal((await readSnapshot("read-version-change", cookie, expected)).kind, "user");
      options.session!.cookieCache!.version = "read-60-v1";
      // Simulate a prior deployment with real Better Auth signing and its original 300-second cache lifetime.
      const legacy = betterAuth({ ...options, session: { ...options.session, cookieCache: { enabled: true, maxAge: 300, refreshCache: false, version: "legacy-300-v1" } } });
      const legacyPost = (path: string, body: unknown) => legacy.handler(new Request(`${options.baseURL}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
      assert.equal((await legacyPost("/email-otp/send-verification-otp", { email: `${variant}@example.test`, type: "sign-in" })).status, 200);
      const oldSigned = await legacyPost("/sign-in/email-otp", { email: `${variant}@example.test`, otp });
      assert.equal(oldSigned.status, 200);
      const oldCookies = oldSigned.headers.getSetCookie();
      assert.ok(oldCookies.some(line => line.includes("session_data=") && /Max-Age=300/i.test(line)));
      const oldCookie = oldCookies.map(line => line.split(";")[0]).join("; ");
      try { Date.now = () => now() + 61_000; assert.equal((await readSnapshot("read-legacy-300-version", oldCookie, expected)).kind, "user"); }
      finally { Date.now = now; }
      assert.equal((await legacy.handler(new Request(`${options.baseURL}/sign-out`, { method: "POST", headers: { cookie: oldCookie, origin: "http://localhost:3000" } }))).status, 200);
    }
    if (variant === "native" || variant === "secondary") {
      // A fresh loader and a retained loader exercise the first request and warm dispatch separately.
      await verifyAuthRequestClasses(() => authLoader(async () => betterAuth(options) as unknown as AuthInstance, prefix), cookie, statements, cached ? expected : 1, expected);
      await verifyAuthRequestClasses(loader, cookie, statements, cached ? expected : 1, expected);
      options.session!.cookieCache!.enabled = false;
      await verifyAuthRequestClasses(loader, cookie, statements, expected, expected);
      options.session!.cookieCache!.enabled = true;
    }
    // Primary rows, not a cached or browser snapshot, own the role and ban state.
    await run(`UPDATE "${u}" SET "${field("role")}" = 'admin' WHERE id = ${dialect === "postgres" ? "$1" : "?"}`, [id]);
    if (!cached) {
      const snapshot = await auth.api.getSession({ headers: new Headers({ cookie }) });
      assert.notEqual((snapshot?.user as { role?: string } | undefined)?.role, "admin", "browser cookie cache is stale and must be bypassed");
    }
    const role = (await check("role", expected)).caller;
    assert.equal(role.kind, "user");
    assert.equal(role.kind === "user" && role.role, "admin");
    if (!cached) {
      const stale = await readSnapshot("read-stale-role");
      assert.equal(stale.kind === "user" && stale.role, "admin");
      statements.length = 0;
      const writer = await resolveCaller(new Request("http://localhost:3000/private", { method: "POST", headers: { cookie } }), loader);
      assert.equal(writer.kind === "user" && writer.role, "admin"); assert.equal(reads(), expected);
      counts[`${variant}:write-current-role`] = reads();
    }
    assert.equal((await check("headers", expected, new Headers())).caller.kind, "user");
    assert.equal(statements.some(text => /^UPDATE /i.test(text)), false, "fresh responseHeaders do not refresh or add an UPDATE");
    await run(`UPDATE "${u}" SET "${field("banned")}" = ${dialect === "postgres" ? "true" : "1"} WHERE id = ${dialect === "postgres" ? "$1" : "?"}`, [id]);
    assert.deepEqual((await check("banned", expected)).caller, { kind: "anonymous" });
    await run(`UPDATE "${u}" SET "${field("banExpires")}" = ${dialect === "postgres" ? "$1" : "?"} WHERE id = ${dialect === "postgres" ? "$2" : "?"}`, [date(Date.now() - 60_000), id]);
    assert.equal((await check("lapsed-ban", expected)).caller.kind, "user");
    await run(`UPDATE "${u}" SET "${field("banned")}" = ${dialect === "postgres" ? "false" : "0"} WHERE id = ${dialect === "postgres" ? "$1" : "?"}`, [id]);
    await run(`UPDATE "${s}" SET "${field("expiresAt")}" = ${dialect === "postgres" ? "$1" : "?"}`, [date(Date.now() + 60_000)]);
    if (cached) for (const [key, text] of cache) {
      const entry = JSON.parse(text);
      if (entry.session?.userId === id) { entry.session.expiresAt = new Date(Date.now() + 60_000).toISOString(); cache.set(key, JSON.stringify(entry)); }
    }
    statements.length = 0;
    assert.equal((await resolveCaller(request(cookie), loader)).kind, "user");
    assert.equal(reads(), expected);
    assert.equal(statements.some(text => /^UPDATE /i.test(text)), false, "without responseHeaders a due cookie must not refresh");
    const refresh = await check("refresh", expected, new Headers());
    assert.equal(refresh.caller.kind, "user");
    assert.ok(refresh.responseHeaders.getSetCookie().some(line => line.includes("session_token=")));
    assert.equal(statements.filter(text => /^UPDATE /i.test(text)).length, 1);
    const [live] = await run(`SELECT "${field("expiresAt")}" AS expiry FROM "${s}"`);
    assert.ok(new Date(live!.expiry as string).getTime() > Date.now() + 86_400_000);
    const expired = date(Date.now() - 60_000);
    await run(`UPDATE "${s}" SET "${field("expiresAt")}" = ${dialect === "postgres" ? "$1" : "?"}`, [expired]);
    const headers = new Headers(); statements.length = 0;
    assert.deepEqual(await resolveCaller(request(cookie), loader, { responseHeaders: headers }), { kind: "anonymous" });
    assert.equal(headers.has("set-cookie"), false);
    assert.equal(statements.filter(text => /^UPDATE /i.test(text)).length, 0);
    const [stillExpired] = await run(`SELECT "${field("expiresAt")}" AS expiry FROM "${s}"`);
    if (stillExpired) assert.equal(new Date(stillExpired.expiry as string).getTime(), new Date(expired).getTime());
    // Deletion must also win over the still-valid secondary snapshot.
    await run(`DELETE FROM "${s}"`); statements.length = 0;
    assert.deepEqual(await resolveCaller(request(cookie), loader, { responseHeaders: new Headers() }), { kind: "anonymous" });
    assert.equal(statements.some(text => /^UPDATE /i.test(text)), false);
    if (!cached) {
      assert.equal((await readSnapshot("read-revoked-within-ttl")).kind, "user");
      const now = Date.now;
      try { Date.now = () => now() + 61_000; assert.deepEqual(await readSnapshot("read-revoked-after-ttl", cookie, 1), { kind: "anonymous" }); }
      finally { Date.now = now; }
    }
    // A fresh sign-in keeps the user-deletion oracle independent of the earlier session revocation.
    assert.equal((await post("/email-otp/send-verification-otp", { email: `${variant}@example.test`, type: "sign-in" })).status, 200);
    const signedAgain = await post("/sign-in/email-otp", { email: `${variant}@example.test`, otp });
    assert.equal(signedAgain.status, 200);
    const newCookie = signedAgain.headers.getSetCookie().map(line => line.split(";")[0]).join("; ");
    assert.equal((await resolveCaller(request(newCookie), loader)).kind, "user");
    await run(`DELETE FROM "${u}" WHERE id = ${dialect === "postgres" ? "$1" : "?"}`, [id]);
    statements.length = 0;
    assert.deepEqual(await resolveCaller(request(newCookie), loader, { responseHeaders: new Headers() }), { kind: "anonymous" });
    assert.equal(statements.some(text => /^UPDATE /i.test(text)), false, "deleted primary user cannot refresh a cached session");
    const signedOut = await auth.handler(new Request(`${options.baseURL}/sign-out`, { method: "POST", headers: { cookie: newCookie, origin: "http://localhost:3000" } }));
    assert.equal(signedOut.status, 200);
    const cleared = signedOut.headers.getSetCookie();
    assert.ok(cleared.some(line => line.includes("session_token=") && /Max-Age=0/i.test(line)));
    assert.ok(cleared.some(line => line.includes("session_data=") && /Max-Age=0/i.test(line)));
    statements.length = 0;
    assert.deepEqual(await resolveCaller(request(), loader, { readOnly: true }), { kind: "anonymous" });
    assert.equal(reads(), 0);

  }
  await verifyOAuthResources(database, dialect, run, statements);
  return counts;
}
