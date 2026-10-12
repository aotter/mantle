import { guardAuthAdminRequest } from "../src/auth/admin.js";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { betterAuth } from "better-auth/minimal";
import { admin, emailOTP } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { d1Identity, d1BootstrapStaff, postgresBootstrapStaff, postgresIdentity } from "../src/auth/identity.js";
import { type SessionCache, type SessionAuthority, authHardening, hashEmailOtp, guardGithubLogin, sessionSecondaryStorage, withAuthTasks, retainAuthTask, authSetupIncomplete } from "../src/auth/hardening.js";
import { d1Adapter, bunSqlAdapter } from "../src/auth/adapter.js";
import { authSchemaSql } from "../src/infrastructure/authSchema.js";
import type { Caller, Postgres } from "../src/kernel/contracts.js";
import { authLoader, resolveCaller } from "../src/auth/caller.js";
import { authOptions as templateOptions, handleAuth } from "./apps/auth/template.js";
import { d1Shim } from "./apps/d1-shim.js";
const ac = createAccessControl(defaultStatements);
const staff: Caller = { kind: "user", subject: "s", role: "staff", scopes: [], credential: "session", credentialId: "session", clientId: null };
const secret = "auth-identity-test-secret-01234567890123456789";
const resources: {
    close(): unknown;
}[] = [];
afterAll(() => {
    for (const r of resources)
        r.close();
});
async function app(pg?: SQL, store?: {
    cache: SessionCache;
    prefix: string;
}) {
    const sqlite = new Database(":memory:");
    resources.push(sqlite);
    sqlite.run("PRAGMA foreign_keys=ON");
    let sent = "";
    const d1 = d1Shim(sqlite), options = { secret, baseURL: "http://localhost/api/auth", session: { storeSessionInDatabase: true }, verification: { storeInDatabase: true }, database: pg ? bunSqlAdapter(pg) : d1Adapter(d1),
        ...authHardening({ ipAddressHeaders: ["cf-connecting-ip"], plugins: [{ id: "email-otp" }], baseURL: "http://localhost" }),
        user: { additionalFields: { githubLogin: { type: "string" as const, required: false } } },
        plugins: [admin({ adminRoles: ["staff"], ac, roles: { staff: ac.newRole(defaultStatements), user: ac.newRole({ user: [], session: [] }) } }), emailOTP({ storeOTP: { hash: otp => hashEmailOtp(secret, otp) }, sendVerificationOTP: async ({ otp }) => { sent = otp; } })] };
    const ddl = authSchemaSql(options, pg ? "postgres" : "sqlite");
    if (pg)
        for (const sql of ddl)
            await pg.unsafe(sql);
    else
        sqlite.exec(ddl.join(";"));
    let getContext: SessionAuthority | undefined;
    if (store)
        Object.assign(options, { secondaryStorage: sessionSecondaryStorage(store.cache, store.prefix, async () => {
                if (!getContext)
                    throw Error("not initialized");
                return getContext();
            }), session: { storeSessionInDatabase: true }, verification: { storeInDatabase: true } });
    const auth = betterAuth(options);
    getContext = () => auth.$context;
    const ctx = await auth.$context;
    await ctx.internalAdapter.createUser({ id: "s", email: "s@example.test", name: "Staff", emailVerified: true, role: "staff", githubLogin: null }, { method: "admin" });
    await auth.api.sendVerificationOTP({ body: { email: "s@example.test", type: "sign-in" } });
    const signed = await auth.api.signInEmailOTP({ body: { email: "s@example.test", otp: sent }, returnHeaders: true });
    const headers = new Headers({ cookie: signed.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") });
    const directory = pg ? postgresIdentity(pg as unknown as Postgres, auth, staff, headers) : d1Identity(d1, auth, staff, headers);
    return { sqlite, d1, auth, ctx, directory, options, headers };
}
test("keyed OTP hash, trusted ingress, profile guard and setup fail closed", async () => {
    expect(await hashEmailOtp(secret, "123456")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await hashEmailOtp(secret, "123456")).not.toBe(await hashEmailOtp("other", "123456"));
    expect(() => authHardening({ ipAddressHeaders: [], baseURL: "https://x.test" })).toThrow("ipAddressHeaders");
    expect(() => authHardening({ ipAddressHeaders: ["trusted"], baseURL: "https://x.test", errorURL: "https://evil.test" })).toThrow("same-origin");
    expect(authHardening({ ipAddressHeaders: ["trusted"], baseURL: "https://x.test", plugins: [{ id: "email-otp" }] }).rateLimit).toMatchObject({ enabled: true, max: 10, window: 60 });
    expect(authHardening({ ipAddressHeaders: ["trusted"], baseURL: "https://x.test", plugins: [{ id: "magic-link" }] }).rateLimit).toMatchObject({ max: 10 });
    expect(authHardening({ ipAddressHeaders: ["trusted"], baseURL: "https://x.test", plugins: [{ id: "jwt" }] }).rateLimit).toMatchObject({ max: 100 });
    expect(guardGithubLogin({ githubLogin: "staff" }, { path: "/update-user" })).toEqual({ data: { githubLogin: null } });
    expect(guardGithubLogin({ githubLogin: "trusted" }, { path: "/callback/:id", params: { id: "github" } })).toBeUndefined();
    expect(guardGithubLogin({ githubLogin: "spoof" }, { path: "/callback/:id", params: { id: "other" } })).toEqual({ data: { githubLogin: null } });
    const r = authSetupIncomplete();
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
});
test("request-scoped waitUntil isolates concurrent sends and session cache excludes verification/counters", async () => {
    const retained: Promise<unknown>[][] = [[], []];
    await Promise.all(retained.map((list, i) => withAuthTasks(p => list.push(p), async () => { await Promise.resolve(); retainAuthTask(Promise.resolve(i)); })));
    expect(retained.map(x => x.length)).toEqual([1, 1]);
    await Promise.all(retained.flat());
    const map = new Map<string, string>(), cache = sessionSecondaryStorage({ get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } }, "deployment-a", async () => { throw Error("verification must never query primary"); });
    await cache.set("verification:otp", "secret", 60);
    expect(await cache.get("verification:otp")).toBeNull();
    expect(map.size).toBe(0);
    await cache.set("session", "value", 1);
    expect(map.get("deployment-a:session")).toBe("value");
    await cache.delete("session");
    expect(map.size).toBe(0);
    await expect(cache.increment!("count", 60)).rejects.toThrow("atomic");
    await expect(cache.getAndDelete!("otp")).rejects.toThrow("verification");
});
test("native member keysets forward/backward, scoped search, staff exclusion and self/credential guards", async () => {
    const a = await app();
    for (let i = 0; i < 5; i++)
        await a.ctx.internalAdapter.createUser({ id: `m${i}`, email: `m${i}@example.test`, name: i === 4 ? "100%" : "Member", emailVerified: false, role: "user", githubLogin: null, createdAt: new Date("2026-01-01T00:00:00Z") }, { method: "admin" });
    const p = await a.directory.listMembers({ limit: 2 });
    expect(p.items.map(x => x.id)).toEqual(["m0", "m1"]);
    const next = await a.directory.listMembers({ limit: 2, cursor: p.nextCursor! });
    expect(next.items.map(x => x.id)).toEqual(["m2", "m3"]);
    const prev = await a.directory.listMembers({ limit: 2, cursor: next.previousCursor!, cursorDirection: "backward" });
    expect(prev.items.map(x => x.id)).toEqual(["m0", "m1"]);
    await expect(a.directory.listMembers({ search: "x", cursor: p.nextCursor! })).rejects.toMatchObject({ code: "INPUT_VALIDATION_FAILED" });
    expect((await a.directory.listMembers({ search: "%" })).items.map(x => x.id)).toEqual(["m4"]);
    await expect(a.directory.setUserRole("s", null)).rejects.toMatchObject({ code: "AUTH_DENIED" });
    await expect(d1Identity(a.d1, a.auth, { ...staff, role: "owner" }, new Headers()).listMembers()).rejects.toMatchObject({ code: "AUTH_DENIED" });
    await expect(d1Identity(a.d1, a.auth, { ...staff, credential: "oauth" }, new Headers()).listMembers()).rejects.toMatchObject({ code: "AUTH_DENIED" });
});
test("D1 bootstrap promotes one contender atomically; invitation revocation guards signed-in users", async () => {
    const a = await app();
    a.sqlite.run("UPDATE user SET role='user'");
    for (const id of ["a", "b"])
        await a.ctx.internalAdapter.createUser({ id, email: `${id}@example.test`, name: id, emailVerified: false, role: "user", githubLogin: "match" }, { method: "admin" });
    const bootstrap = d1BootstrapStaff(a.d1, { match: "github-login", value: "MATCH" });
    await Promise.all([bootstrap({ id: "a", githubLogin: "match" }), bootstrap({ id: "b", githubLogin: "match" })]);
    expect(a.sqlite.query("SELECT id FROM user WHERE role='staff'").all()).toHaveLength(1);
    a.sqlite.run("UPDATE user SET role='staff' WHERE id='s'");
    a.sqlite.run("UPDATE user SET role='staff' WHERE id IN ('a','b')");
    expect(await a.directory.revokeInvite("a")).toBe(true);
    a.sqlite.run('UPDATE user SET "emailVerified"=1 WHERE id=\'b\'');
    expect(await a.directory.revokeInvite("b")).toBe(false);
});
const pgUrl = process.env.MANTLE_NEXT_BUN_PG_URL;
test.skipIf(!pgUrl)("PostgreSQL competing bootstrap transactions serialize and native member paging works", async () => {
    const db = new SQL(pgUrl!), schema = `identity_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
        await db.unsafe(`CREATE SCHEMA ${schema}`);
        await db.unsafe(`SET search_path TO ${schema}`);
        // Keep pool connections on the same isolated schema.
        const scoped = new SQL({ url: pgUrl!, max: 4, connection: { search_path: schema } });
        try {
            const primaryCache = new Map<string, string>();
            const a = await app(scoped, { prefix: schema, cache: { get: async (k) => primaryCache.get(k) ?? null, set: async (k, v) => { primaryCache.set(k, v); }, delete: async (k) => { primaryCache.delete(k); } } });
            expect(await resolveCaller(new Request("http://localhost/private", { headers: a.headers }), authLoader(async () => a.auth))).toMatchObject({ role: "staff" });
            a.sqlite.close();
            resources.splice(resources.indexOf(a.sqlite), 1);
            await a.ctx.internalAdapter.updateUser("s", { role: "user" });
            for (const id of ["a", "b"])
                await a.ctx.internalAdapter.createUser({ id, email: `${id}@example.test`, name: id, emailVerified: false, role: "user", githubLogin: "match" }, { method: "admin" });
            const bootstrap = postgresBootstrapStaff(scoped as unknown as Postgres, { match: "github-login", value: "match" });
            await Promise.all([bootstrap({ id: "a", githubLogin: "match" }), bootstrap({ id: "b", githubLogin: "match" })]);
            expect(await scoped.unsafe(`SELECT id FROM "user" WHERE role='staff'`)).toHaveLength(1);
            expect((await a.directory.listMembers({ limit: 1 })).items).toHaveLength(1);
            for (const [id, clock] of [["z_micro", "2026-02-01T00:00:00.000001Z"], ["a_micro", "2026-02-01T00:00:00.000002Z"], ["m_micro", "2026-02-01T00:00:00.000003Z"]]) {
                await a.ctx.internalAdapter.createUser({ id, email: `${id}@example.test`, name: "Microseconds", emailVerified: true, role: "user" }, { method: "admin" });
                await scoped.unsafe(`UPDATE "user" SET "createdAt"=CAST(CAST($1 AS text) AS timestamptz) WHERE id=$2`, [clock, id]);
            }
            const visited: string[] = [];
            let cursor: string | undefined;
            do {
                const page = await a.directory.listMembers({ search: "micro", limit: 1, cursor });
                visited.push(...page.items.map(item => item.id));
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            expect(visited).toEqual(["z_micro", "a_micro", "m_micro"]);
        }
        finally {
            await scoped.close();
        }
    }
    finally {
        await db.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        await db.close();
    }
});
test("template schema constructs without runtime env or boot queries", () => { expect(authSchemaSql(templateOptions({} as never), "sqlite").join(";")).toContain("githubLogin"); });
test("official admin role/invite/delete APIs preserve permissions and invalidate user sessions", async () => {
    const a = await app();
    expect((await a.directory.listUsers()).map(x => x.id)).toEqual(["s"]);
    const invited = await a.directory.inviteUser(" INVITED@example.test ");
    expect(invited.kind).toBe("created");
    expect((await a.directory.listUsers()).map(x => x.id)).toContain(invited.id);
    expect(await a.directory.setUserRole(invited.id, null)).toBe(true);
    expect((await a.directory.listMembers({ search: "invited" })).items).toHaveLength(1);
    await expect(a.directory.inviteUser("invited@example.test")).rejects.toMatchObject({ code: "AUTH_DENIED" });
    await a.ctx.internalAdapter.updateUser(invited.id, { emailVerified: true });
    expect((await a.directory.inviteUser("invited@example.test")).kind).toBe("exists");
    expect(await a.directory.setUserRole("missing", null)).toBe(false);
    await a.ctx.internalAdapter.createSession(invited.id, false);
    await a.ctx.adapter.create({ model: "verification", data: { identifier: "sign-in-otp-invited@example.test", value: "hmac", expiresAt: new Date(Date.now() + 60000), createdAt: new Date(), updatedAt: new Date() } });
    expect(await a.directory.deleteUser(invited.id)).toBe(true);
    expect(await a.ctx.internalAdapter.findUserById(invited.id)).toBeNull();
    expect(a.sqlite.query('SELECT id FROM session WHERE "userId"=?').all(invited.id)).toHaveLength(0);
    expect(a.sqlite.query('SELECT id FROM verification WHERE identifier=?').all("sign-in-otp-invited@example.test")).toHaveLength(0);
    expect(await a.directory.deleteUser(invited.id)).toBe(false);
});
test("configured session cache never handles OTP consumption or atomic attempts", async () => {
    const map = new Map<string, string>();
    const cache: SessionCache = { get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
    const a = await app(undefined, { cache, prefix: "live-db" });
    expect([...map.keys()].some(k => k.includes("verification:"))).toBe(false);
    expect(await a.ctx.internalAdapter.consumeVerificationValue("missing-proof")).toBeNull();
});
test("email bootstrap cannot grant staff to an unverified matching address", async () => {
    const a = await app();
    a.sqlite.run("UPDATE user SET role='user'");
    const hook = d1BootstrapStaff(a.d1, { match: "email", value: "s@example.test" });
    await hook({ id: "s", email: "s@example.test", emailVerified: false });
    expect(a.sqlite.query("SELECT id FROM user WHERE role='staff'").all()).toHaveLength(0);
    await hook({ id: "s", email: "s@example.test", emailVerified: true });
    expect(a.sqlite.query("SELECT id FROM user WHERE role='staff'").all()).toHaveLength(1);
});
test("KV failures cannot preserve staff roles, bans or revoked sessions", async () => {
    const values = new Map<string, string>();
    let broken = false;
    const cache: SessionCache = { get: async (key) => values.get(key) ?? null, set: async (key, value) => {
            if (broken)
                throw Error("KV unavailable");
            values.set(key, value);
        }, delete: async (key) => {
            if (broken)
                throw Error("KV unavailable");
            values.delete(key);
        } };
    const a = await app(undefined, { cache, prefix: "authoritative-db" }), loader = authLoader(async () => a.auth);
    const request = new Request("http://localhost/private", { headers: a.headers });
    expect(await resolveCaller(request, loader)).toMatchObject({ role: "staff" });
    broken = true;
    await a.auth.api.setRole({ headers: a.headers, body: { userId: "s", role: "user" } });
    expect(await resolveCaller(request, loader)).toMatchObject({ role: "user" });
    const raw = new Request("http://localhost/api/auth/admin/list-users", { headers: a.headers });
    expect((await handleAuth(a.auth as never, raw, () => { })).status).toBe(403);
    const encoded = new Request("http://localhost/api/auth/%61dmin/list-users", { headers: a.headers });
    expect((await handleAuth(a.auth as never, encoded, () => { })).status).toBe(403);
    a.sqlite.run("UPDATE user SET banned=1 WHERE id='s'");
    expect(await resolveCaller(request, loader)).toEqual({ kind: "anonymous" });
    a.sqlite.run("UPDATE user SET banned=0 WHERE id='s'");
    a.sqlite.run(`DELETE FROM session WHERE "userId"='s'`);
    expect(await resolveCaller(request, loader)).toEqual({ kind: "anonymous" });
});
test("shared admin guard is lazy outside admin and checks mutation origin", async () => {
    let calls = 0;
    const resolve = () => { calls++; return staff; };
    await guardAuthAdminRequest(new Request("https://x.test/api/auth/jwks"), resolve);
    expect(calls).toBe(0);
    await expect(guardAuthAdminRequest(new Request("https://x.test/api/auth/admin/set-role", { method: "POST" }), resolve)).rejects.toMatchObject({ code: "AUTH_DENIED", path: "request:origin" });
    await guardAuthAdminRequest(new Request("https://x.test/api/auth/admin/set-role", { method: "POST", headers: { origin: "https://x.test" } }), resolve);
    expect(calls).toBe(2);
});
test("authority-bound KV cannot resurrect expired sessions and session listing rebuilds a missing index", async () => {
    const values = new Map<string, string>();
    let broken = false;
    const cache: SessionCache = { get: async (k) => values.get(k) ?? null, set: async (k, v) => {
            if (broken)
                throw Error("optional KV down");
            values.set(k, v);
        }, delete: async (k) => {
            if (broken)
                throw Error("optional KV down");
            values.delete(k);
        } };
    const a = await app(undefined, { cache, prefix: "expiry-proof" });
    const before = a.sqlite.query(`SELECT id,token FROM session WHERE "userId"='s'`).get() as {
        id: string;
        token: string;
    };
    values.delete("expiry-proof:active-sessions-s");
    expect(await a.auth.api.listSessions({ headers: a.headers })).toHaveLength(1);
    for (const [key, raw] of values) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed.session?.id === before.id) {
                parsed.session.expiresAt = new Date(Date.now() + 60000).toISOString();
                values.set(key, JSON.stringify(parsed));
            }
        }
        catch { }
    }
    a.sqlite.run('UPDATE session SET "expiresAt"=? WHERE id=?', [new Date(Date.now() - 60000).toISOString(), before.id]);
    broken = true;
    const raw = await a.auth.handler(new Request("http://localhost/api/auth/get-session", { headers: a.headers }));
    expect(raw.status).toBe(200);
    expect(await raw.json()).toBeNull();
    const after = a.sqlite.query('SELECT "expiresAt" FROM session WHERE id=?').get(before.id) as {
        expiresAt: string;
    } | null;
    expect(!after || Date.parse(after.expiresAt) < Date.now()).toBe(true);
    expect(await resolveCaller(new Request("http://localhost/private", { headers: a.headers }), authLoader(async () => a.auth), { responseHeaders: new Headers() })).toEqual({ kind: "anonymous" });
});
test("authority cache plus joined caller guard and two-session listing have explicit database counts", async () => {
    const values = new Map<string, string>();
    const a = await app(undefined, { prefix: "counts", cache: { get: async (k) => values.get(k) ?? null, set: async (k, v) => { values.set(k, v); }, delete: async (k) => { values.delete(k); } } });
    await a.ctx.internalAdapter.createSession("s", false);
    let reads = 0;
    const one = a.ctx.adapter.findOne.bind(a.ctx.adapter), many = a.ctx.adapter.findMany.bind(a.ctx.adapter);
    a.ctx.adapter.findOne = async (...args) => { reads++; return one(...args); };
    a.ctx.adapter.findMany = async (...args) => { reads++; return many(...args); };
    expect(await resolveCaller(new Request("http://localhost/private", { headers: a.headers }), authLoader(async () => a.auth))).toMatchObject({ role: "staff" });
    expect(reads).toBe(2);
    reads = 0;
    expect(await a.ctx.internalAdapter.listSessions("s")).toHaveLength(2);
    expect(reads).toBe(3);
});
test("generated auth member index follows the user's native table and createdAt mapping", () => {
    const ddl = authSchemaSql({ user: { modelName: "people", fields: { createdAt: "joined_at" } } }, "postgres").join(";");
    expect(ddl).toContain('ON "people" ("joined_at", "id")');
});
