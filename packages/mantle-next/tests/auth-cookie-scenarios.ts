/** One real Better Auth cookie oracle, shared by SQLite, PostgreSQL and local D1. No credentials leave this fixture. */
import assert from "node:assert/strict";
import type { BetterAuthOptions } from "@better-auth/core";
import { betterAuth } from "better-auth/minimal";
import { admin, emailOTP } from "better-auth/plugins";
import { authLoader, resolveCaller, type AuthInstance } from "../src/auth/caller.js";
import { authSchemaSql } from "../src/auth/schema.js";

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
    const options: BetterAuthOptions = {
      baseURL: "http://localhost:3000/api/auth", secret: "cookie-fixture-secret-0123456789-0123456789",
      database,
      user: { modelName: u, ...(renamed ? { fields: { name: field("name"), email: field("email"), emailVerified: field("emailVerified"), createdAt: field("createdAt"), updatedAt: field("updatedAt"), image: field("image") } } : {}) },
      session: { modelName: s, ...(cached ? { storeSessionInDatabase: true } : {}), ...(renamed ? { fields: { userId: field("userId"), token: field("token"), expiresAt: field("expiresAt"), createdAt: field("createdAt"), updatedAt: field("updatedAt"), ipAddress: field("ipAddress"), userAgent: field("userAgent") } } : {}) },
      account: { modelName: `${prefix}account` }, verification: { modelName: `${prefix}verification`, storeInDatabase: true },
      ...(cached ? { secondaryStorage: { get: async key => cache.get(key) ?? null, set: async (key, value) => { cache.set(key, value); }, delete: async key => { cache.delete(key); }, getAndDelete: async () => { throw Error("verification stays in the primary database"); }, increment: async () => { throw Error("verification stays in the primary database"); } } } : {}),
      advanced: { database: { ...(variant === "fallback" ? { joins: false } : {}) }, cookiePrefix: prefix },
      // Better Auth's admin plugin mutates its shared schema when fields are renamed; reset every field per fixture.
      plugins: [admin({ schema: { user: { fields: { role: field("role"), banned: field("banned"), banReason: field("banReason"), banExpires: field("banExpires") } } } }), emailOTP({ sendVerificationOTP: async value => { otp = value.otp; } })],
    };
    for (const text of authSchemaSql(options, dialect)) await run(text);
    const auth = betterAuth(options);
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
    const check = async (name: string, expected: number, responseHeaders = new Headers()) => {
      statements.length = 0;
      const caller = await resolveCaller(request(cookie), loader, { responseHeaders });
      assert.equal(reads(), expected, `${variant}/${name}: ${statements.join("\n")}`);
      counts[`${variant}:${name}`] = reads();
      return { caller, responseHeaders };
    };
    const expected = cached ? 1 : variant === "fallback" ? 4 : 2;
    assert.equal((await check("fresh", expected)).caller.kind, "user");
    // Primary rows, not a cached or browser snapshot, own the role and ban state.
    await run(`UPDATE "${u}" SET "${field("role")}" = 'staff' WHERE id = ${dialect === "postgres" ? "$1" : "?"}`, [id]);
    const role = (await check("role", expected)).caller;
    assert.equal(role.kind, "user");
    assert.equal(role.kind === "user" && role.role, "staff");
    await run(`UPDATE "${u}" SET "${field("banned")}" = ${dialect === "postgres" ? "true" : "1"} WHERE id = ${dialect === "postgres" ? "$1" : "?"}`, [id]);
    assert.deepEqual((await check("banned", expected)).caller, { kind: "anonymous" });
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
    const refresh = await check("refresh", expected);
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
  }
  return counts;
}
