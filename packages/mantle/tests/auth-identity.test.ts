import { fixtureCaller } from "./apps/fixtures.js";
import { guardAuthAdminRequest } from "../src/auth/admin.js";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import type { BetterAuthOptions } from "better-auth/types";
import { betterAuth } from "better-auth/minimal";
import { admin as adminFunction, emailOTP } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { d1Identity, d1BootstrapAdmin, postgresBootstrapAdmin, postgresIdentity } from "../src/auth/identity.js";
import { authHardening, hashEmailOtp, guardGithubLogin, withAuthTasks, retainAuthTask, authSetupIncomplete } from "../src/auth/hardening.js";
import { d1Adapter, bunSqlAdapter } from "../src/auth/adapter.js";
import { authSchemaSql } from "../src/infrastructure/authSchema.js";
import type { Caller, Postgres } from "../src/kernel/contracts.js";
import { authLoader, resolveCaller } from "../src/auth/caller.js";
import { authOptions as templateOptions, handleAuth } from "./apps/auth/template.js";
import { d1Shim } from "./apps/d1-shim.js";
const ac = createAccessControl(defaultStatements);
const admin: Caller = fixtureCaller({ kind: "user", subject: "s", role: "admin", admin: true, scopes: [], credential: "session", credentialId: "session", clientId: null });
type SessionCache = { get(key: string): Promise<string | null>; set(key: string, value: string, ttl?: number): Promise<unknown>; delete(key: string): Promise<unknown> };
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
}, adminRoles: readonly string[] = ["admin"], config: { db?: Database; prefix?: string; defaultRole?: string } = {}) {
    const sqlite = config.db ?? new Database(":memory:");
    if (!config.db) resources.push(sqlite);
    sqlite.run("PRAGMA foreign_keys=ON");
    let sent = "";
    const d1 = d1Shim(sqlite), options = { secret, baseURL: "http://localhost/api/auth", session: { storeSessionInDatabase: true }, verification: { storeInDatabase: true }, database: pg ? bunSqlAdapter(pg) : d1Adapter(d1),
        ...authHardening({ ipAddressHeaders: ["cf-connecting-ip"], baseURL: "http://localhost" }),
        user: { ...(config.prefix ? { modelName: `${config.prefix}_people`, fields: { createdAt: "joined_at", emailVerified: "verified" } } : {}), additionalFields: (config.prefix ? {} : { githubLogin: { type: "string" as const, required: false } }) as NonNullable<BetterAuthOptions["user"]>["additionalFields"] },
        ...(config.prefix ? { session: { storeSessionInDatabase: true, modelName: `${config.prefix}_sessions` }, account: { modelName: `${config.prefix}_accounts` }, verification: { storeInDatabase: true, modelName: `${config.prefix}_proofs` } } : {}),
        plugins: [adminFunction({ defaultRole: config.defaultRole, schema: config.prefix ? { user: { fields: { role: "roles" } } } : undefined, adminRoles: [...adminRoles], ac, roles: { admin: ac.newRole({ user: [], session: [] }), editor: ac.newRole({ user: [], session: [] }), ...Object.fromEntries(adminRoles.map(role => [role, ac.newRole(defaultStatements)])), user: ac.newRole({ user: [], session: [] }), guest: ac.newRole({ user: [], session: [] }), vip: ac.newRole({ user: [], session: [] }), approver: ac.newRole({ user: [], session: [] }), operator: ac.newRole(defaultStatements), support: ac.newRole({ user: ["list"], session: [] }), denied: ac.newRole({ user: [], session: [] }) } }), emailOTP({ storeOTP: { hash: otp => hashEmailOtp(secret, otp) }, sendVerificationOTP: async ({ otp }) => { sent = otp; } })] };
    const ddl = authSchemaSql(options, pg ? "postgres" : "sqlite");
    if (pg)
        for (const sql of ddl)
            await pg.unsafe(sql);
    else
        sqlite.exec(ddl.join(";"));
    if (store)
        Object.assign(options, { secondaryStorage: { get: (k: string) => store.cache.get(`${store.prefix}:${k}`), set: (k: string, v: string, ttl?: number) => store.cache.set(`${store.prefix}:${k}`, v, ttl), delete: (k: string) => store.cache.delete(`${store.prefix}:${k}`) }, session: { storeSessionInDatabase: true }, verification: { storeInDatabase: true } });
    const auth = betterAuth(options);
    const ctx = await auth.$context;
    await ctx.internalAdapter.createUser({ id: "s", email: "s@example.test", name: "Admin", emailVerified: true, role: adminRoles.join(","), githubLogin: null }, { method: "admin" });
    await auth.api.sendVerificationOTP({ body: { email: "s@example.test", type: "sign-in" } });
    const signed = await auth.api.signInEmailOTP({ body: { email: "s@example.test", otp: sent }, returnHeaders: true });
    const headers = new Headers({ cookie: signed.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") });
    const directory = pg ? postgresIdentity(pg as unknown as Postgres, auth, admin, headers) : d1Identity(d1, auth, admin, headers);
    return { sqlite, d1, auth, ctx, directory, options, headers };
}
test("keyed OTP hash, trusted ingress, profile guard and setup fail closed", async () => {
    expect(await hashEmailOtp(secret, "123456")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await hashEmailOtp(secret, "123456")).not.toBe(await hashEmailOtp("other", "123456"));
    expect(() => authHardening({ ipAddressHeaders: [], baseURL: "https://x.test" })).toThrow("ipAddressHeaders");
    expect(() => authHardening({ ipAddressHeaders: ["trusted"], baseURL: "https://x.test", errorURL: "https://evil.test" })).toThrow("same-origin");
    expect(authHardening({ ipAddressHeaders: ["trusted"], baseURL: "https://x.test" }).rateLimit).toEqual({ enabled: true, storage: "database" });
    expect(guardGithubLogin({ githubLogin: "admin" }, { path: "/update-user" })).toEqual({ data: { githubLogin: null } });
    expect(guardGithubLogin({ githubLogin: "trusted" }, { path: "/callback/:id", params: { id: "github" } })).toBeUndefined();
    expect(guardGithubLogin({ githubLogin: "spoof" }, { path: "/callback/:id", params: { id: "other" } })).toEqual({ data: { githubLogin: null } });
    const r = authSetupIncomplete();
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
});
test("request-scoped waitUntil isolates concurrent sends", async () => {
    const retained: Promise<unknown>[][] = [[], []];
    await Promise.all(retained.map((list, i) => withAuthTasks(p => list.push(p), async () => { await Promise.resolve(); retainAuthTask(Promise.resolve(i)); })));
    expect(retained.map(x => x.length)).toEqual([1, 1]);
    await Promise.all(retained.flat());
});
test("native member keysets forward/backward, scoped search and Better Auth access control", async () => {
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
    await expect(a.directory.setUserRole("s", null)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(d1Identity(a.d1, a.auth, fixtureCaller({ ...admin, role: "owner", admin: false }), new Headers()).listMembers()).rejects.toMatchObject({ code: "AUTH_DENIED" });
    await expect(d1Identity(a.d1, a.auth, fixtureCaller({ ...admin, credential: "oauth" }), new Headers()).listMembers()).rejects.toMatchObject({ code: "AUTH_DENIED" });
});
test("D1 bootstrap promotes one contender atomically; invitation revocation guards signed-in users", async () => {
    const a = await app();
    a.sqlite.run("UPDATE user SET role='user'");
    for (const id of ["a", "b"])
        await a.ctx.internalAdapter.createUser({ id, email: `${id}@example.test`, name: id, emailVerified: false, role: "user", githubLogin: "match" }, { method: "admin" });
    const bootstrap = d1BootstrapAdmin(a.d1, { match: "github-login", value: "MATCH" }, a.auth);
    await Promise.all([bootstrap({ id: "a", githubLogin: "match" }), bootstrap({ id: "b", githubLogin: "match" })]);
    expect(a.sqlite.query("SELECT id FROM user WHERE role LIKE '%admin%'").all()).toHaveLength(1);
    a.sqlite.run("UPDATE user SET role='admin' WHERE id='s'");
    a.sqlite.run("UPDATE user SET role='admin' WHERE id IN ('a','b')");
    expect(await a.directory.revokeInvite("a")).toBe(true);
    a.sqlite.run('UPDATE user SET "emailVerified"=1 WHERE id=\'b\'');
    expect(await a.directory.revokeInvite("b")).toBe(false);
});
const pgUrl = process.env.MANTLE_NEXT_BUN_PG_URL;
test.skipIf(!pgUrl)("PostgreSQL UUID member search casts only the search expression, preserving native keyset order", async () => {
    const schema = `uuid_members_${crypto.randomUUID().replaceAll("-", "")}`, adminDb = new SQL(pgUrl!);
    await adminDb.unsafe(`CREATE SCHEMA ${schema}`);
    const db = new SQL({ url: pgUrl!, max: 1, connection: { search_path: schema } }), statements: string[] = [];
    try {
        await db.unsafe(`CREATE TABLE "user" (id uuid PRIMARY KEY, email text, name text, role text, "githubLogin" text, "emailVerified" boolean, "createdAt" timestamptz)`);
        const ids = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"];
        for (const id of ids) await db.unsafe(`INSERT INTO "user" VALUES ($1,$2,'Member',NULL,NULL,true,'2026-02-01T00:00:00.000001Z')`, [id, `${id}@example.test`]);
        const handle = { unsafe: (text: string, values: unknown[]) => { statements.push(text); return db.unsafe(text, values); } };
        const directory = postgresIdentity(handle as unknown as Postgres, { options: { database: bunSqlAdapter(db), plugins: [adminFunction()], user: { additionalFields: { githubLogin: { type: "string", required: false } } } }, api: { userHasPermission: async () => ({ success: true }) } } as never, admin, new Headers());
        expect((await directory.listMembers({ search: "000001" })).items.map(row => row.id)).toEqual([ids[0]!]);
        expect((await directory.listMembers({ search: "MEMBER" })).items.map(row => row.id)).toEqual(ids);
        statements.length = 0;
        const first = await directory.listMembers({ limit: 1 });
        const second = await directory.listMembers({ limit: 1, cursor: first.nextCursor! });
        expect([...first.items, ...second.items].map(row => row.id)).toEqual(ids);
        expect(statements).toHaveLength(2);
        expect(statements.every(text => !text.includes("CAST(id AS text)"))).toBe(true);
        expect(statements[1]).toContain('AND "id" >');
    } finally { await db.close(); await adminDb.unsafe(`DROP SCHEMA ${schema} CASCADE`); await adminDb.close(); }
});
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
            expect(await resolveCaller(new Request("http://localhost/private", { headers: a.headers }), authLoader(async () => a.auth))).toMatchObject({ role: "admin", admin: true });
            a.sqlite.close();
            resources.splice(resources.indexOf(a.sqlite), 1);
            // Fixture-only reset creates the empty admin directory whose bootstrap is under test.
            await scoped.unsafe(`UPDATE "user" SET role='user' WHERE id='s'`);
            for (const id of ["a", "b"])
                await a.ctx.internalAdapter.createUser({ id, email: `${id}@example.test`, name: id, emailVerified: false, role: "user", githubLogin: "match" }, { method: "admin" });
            const bootstrap = postgresBootstrapAdmin(scoped as unknown as Postgres, { match: "github-login", value: "match" }, a.auth);
            await Promise.all([bootstrap({ id: "a", githubLogin: "match" }), bootstrap({ id: "b", githubLogin: "match" })]);
            expect(await scoped.unsafe(`SELECT id FROM "user" WHERE role LIKE '%admin%'`)).toHaveLength(1);
            // The directory acts as session 's', which the test demoted above: Better Auth access control needs it to be an admin again.
            await scoped.unsafe(`UPDATE "user" SET role='admin' WHERE id='s'`);
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
/** The caller `s` is not admin here, so two other admin members exist to compete for the last seat. */
async function lastAdmin(a: Awaited<ReturnType<typeof app>>) {
    const adminIds = async () => (await a.ctx.adapter.findMany({ model: "user", where: [{ field: "role", value: "admin" }] }) as { id: string }[]).map(u => u.id).sort();
    for (const id of ["a", "b"])
        await a.ctx.internalAdapter.createUser({ id, email: `${id}@example.test`, name: id, emailVerified: true, role: "admin", githubLogin: null }, { method: "admin" });
    await a.ctx.internalAdapter.updateUser("s", { role: "operator" });
    const results = await Promise.allSettled([a.directory.setUserRole("a", null), a.directory.setUserRole("b", null)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason)).toMatchObject([{ code: "CONFLICT", message: expect.stringContaining("last admin") }]);
    const [last] = await adminIds();
    expect(await adminIds()).toHaveLength(1);
    await expect(a.directory.setUserRole(last!, null)).rejects.toMatchObject({ code: "CONFLICT" });
    const kept = await a.ctx.internalAdapter.createSession(last!);
    await expect(a.directory.deleteUser(last!)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await a.ctx.internalAdapter.findSession(kept.token)).not.toBeNull();
    expect(await adminIds()).toEqual([last!]);
    expect(await a.ctx.internalAdapter.findUserById(last!)).not.toBeNull();
    // with another admin member promoted, either can go; a plain member is never blocked
    await a.ctx.internalAdapter.createUser({ id: "c", email: "c@example.test", name: "c", emailVerified: true, role: "user", githubLogin: null }, { method: "admin" });
    await a.ctx.internalAdapter.updateUser("c", { role: "admin", admin: true });
    expect(await a.directory.deleteUser(last!)).toBe(true);
    expect(await adminIds()).toEqual(["c"]);
    expect(await a.directory.setUserRole(["a", "b"].find(id => id !== last)!, null)).toBe(true);
    await expect(a.directory.setUserRole("c", null)).rejects.toMatchObject({ code: "CONFLICT" });
}
test("the last admin member can be neither demoted nor deleted, and concurrent demotions leave one (SQLite)", async () => {
    await lastAdmin(await app());
});
test.skipIf(!pgUrl)("the last admin member can be neither demoted nor deleted, and concurrent demotions leave one (PostgreSQL)", async () => {
    const schema = `last_admin_${crypto.randomUUID().replaceAll("-", "")}`, db = new SQL(pgUrl!);
    try {
        await db.unsafe(`CREATE SCHEMA ${schema}`);
        const scoped = new SQL({ url: pgUrl!, max: 4, connection: { search_path: schema } });
        try {
            const a = await app(scoped);
            a.sqlite.close();
            resources.splice(resources.indexOf(a.sqlite), 1);
            await lastAdmin(a);
        }
        finally { await scoped.close(); }
    }
    finally { await db.unsafe(`DROP SCHEMA ${schema} CASCADE`); await db.close(); }
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
test("email bootstrap cannot grant admin to an unverified matching address", async () => {
    const a = await app();
    a.sqlite.run("UPDATE user SET role='user'");
    const hook = d1BootstrapAdmin(a.d1, { match: "email", value: "s@example.test" }, a.auth);
    await hook({ id: "s", email: "s@example.test", emailVerified: false });
    expect(a.sqlite.query("SELECT id FROM user WHERE role LIKE '%admin%'").all()).toHaveLength(0);
    await hook({ id: "s", email: "s@example.test", emailVerified: true });
    expect(a.sqlite.query("SELECT id FROM user WHERE role LIKE '%admin%'").all()).toHaveLength(1);
});
test("KV failures cannot preserve admin roles, bans or revoked sessions", async () => {
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
    expect(await resolveCaller(request, loader)).toMatchObject({ role: "admin", admin: true });
    await a.ctx.internalAdapter.createUser({ id: "spare-admin", email: "spare@example.test", name: "Spare", emailVerified: true, role: "admin" }, { method: "admin" });
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
    const resolve = () => { calls++; return admin; };
    await guardAuthAdminRequest(new Request("https://x.test/api/auth/jwks"), resolve);
    expect(calls).toBe(0);
    await expect(guardAuthAdminRequest(new Request("https://x.test/api/auth/admin/set-role", { method: "POST" }), resolve)).rejects.toMatchObject({ code: "AUTH_DENIED", path: "request:origin" });
    await guardAuthAdminRequest(new Request("https://x.test/api/auth/admin/set-role", { method: "POST", headers: { origin: "https://x.test" } }), resolve);
    expect(calls).toBe(2);
    const member = fixtureCaller({ ...admin, role: "user", admin: false });
    for (const endpoint of ["has-permission", "stop-impersonating"])
        await guardAuthAdminRequest(new Request(`https://x.test/api/auth/admin/${endpoint}`, { method: "POST", headers: { origin: "https://x.test" } }), () => member);
});
test("generated auth member index follows the user's native table and createdAt mapping", () => {
    const ddl = authSchemaSql({ user: { modelName: "people", fields: { createdAt: "joined_at" } } }, "postgres").join(";");
    expect(ddl).toContain('ON "people" ("joined_at", "id")');
});

test("configured comma-separated admins stay out of members and retain the last-admin guard", async () => {
    const a = await app(undefined, undefined, ["orgAdmin", "editor"]);
    await a.ctx.internalAdapter.createUser({ id: "custom", email: "custom@example.test", name: "Custom", emailVerified: true, role: "vip,editor" }, { method: "admin" });
    await a.ctx.internalAdapter.createUser({ id: "member", email: "member@example.test", name: "Member", emailVerified: true, role: "admin", admin: true }, { method: "admin" });
    expect((await a.directory.listUsers()).map(row => row.id)).toEqual(expect.arrayContaining(["s", "custom"]));
    expect((await a.directory.listMembers()).items.map(row => row.id)).toEqual(["member"]);
    await expect(a.directory.setUserRole("member", "admin")).rejects.toMatchObject({ code: "INPUT_VALIDATION_FAILED" });
    expect(await a.directory.setUserRole("member", "editor")).toBe(true);
    expect(await a.directory.setUserRole("member", null)).toBe(true);
    expect(await a.directory.setUserRole("custom", null)).toBe(true);
    // Remove the session actor through a different trusted caller; only the last-admin guard can stop this.
    const other = d1Identity(a.d1, a.auth, fixtureCaller({ ...admin, subject: "other" }) as Caller, a.headers);
    await expect(other.setUserRole("s", null)).rejects.toMatchObject({ code: "CONFLICT" });
    const bootstrap = d1BootstrapAdmin(a.d1, { match: "email", value: "member@example.test" }, a.auth);
    await bootstrap({ id: "member", email: "member@example.test", emailVerified: true });
    expect(a.sqlite.query("SELECT role FROM user WHERE id='member'").get()).toEqual({ role: "admin" });
});

async function nativeLastAdmin(a: Awaited<ReturnType<typeof app>>) {
    const adapter = a.ctx.adapter;
    const where = (id: string) => [{ field: "id", value: id }];
    for (const update of [{ role: "user" }, { banned: true }])
        await expect(adapter.update({ model: "user", where: where("s"), update })).rejects.toMatchObject({ body: { code: "CONFLICT" } });
    await expect(adapter.delete({ model: "user", where: where("s") })).rejects.toMatchObject({ body: { code: "CONFLICT" } });
    await expect(adapter.updateMany({ model: "user", where: [], update: { role: "user" } })).rejects.toMatchObject({ body: { code: "AUTH_DENIED" } });
    expect(await adapter.findOne({ model: "user", where: where("s") })).toMatchObject({ role: "editor", banned: false });
    await a.ctx.internalAdapter.createUser({ id: "second", email: "second@example.test", name: "Second", emailVerified: true, role: "editor" }, { method: "admin" });
    const outcomes = await Promise.allSettled(["s", "second"].map(id => adapter.update({ model: "user", where: where(id), update: { role: "user" } })));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    const remaining = await adapter.findMany<{ id: string }>({ model: "user", where: [{ field: "role", value: "editor" }] });
    expect(remaining).toHaveLength(1);
    await expect(adapter.update({ model: "user", where: where(remaining[0]!.id), update: { banned: true } })).rejects.toMatchObject({ body: { code: "CONFLICT" } });
}
test("native auth writes cannot bypass the last configured admin (D1)", async () => {
    await nativeLastAdmin(await app(undefined, undefined, ["editor"]));
});
test.skipIf(!pgUrl)("native auth writes serialize competing demotions and bans (PostgreSQL)", async () => {
    const schema = `native_admin_${crypto.randomUUID().replaceAll("-", "")}`, db = new SQL(pgUrl!);
    await db.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new SQL({ url: pgUrl!, max: 4, connection: { search_path: schema } });
    try { await nativeLastAdmin(await app(scoped, undefined, ["editor"])); }
    finally { await scoped.close(); await db.unsafe(`DROP SCHEMA ${schema} CASCADE`); await db.close(); }
});


test("role grants, demotions and bootstrap preserve other roles and use the plugin default", async () => {
    const a = await app(undefined, undefined, ["admin", "org-admin"], { defaultRole: "guest" });
    for (const [id, role] of [["mixed", "admin,editor"], ["member", "editor"], ["only", "org-admin"]] as const)
        await a.ctx.internalAdapter.createUser({ id, email: `${id}@example.test`, name: id, emailVerified: true, role }, { method: "admin" });
    expect(await a.directory.setUserRole("mixed", null)).toBe(true);
    expect(await a.ctx.internalAdapter.findUserById("mixed")).toMatchObject({ role: "editor" });
    expect(await a.directory.setUserRole("member", "org-admin")).toBe(true);
    expect(await a.ctx.internalAdapter.findUserById("member")).toMatchObject({ role: "editor,org-admin" });
    expect(await a.directory.setUserRole("only", null)).toBe(true);
    expect(await a.ctx.internalAdapter.findUserById("only")).toMatchObject({ role: "guest" });
    await a.directory.setUserRole("mixed", []);
    expect(await a.ctx.internalAdapter.findUserById("mixed")).toMatchObject({ role: "guest" });
    // Better Auth permits changing one's own role while another admin remains.
    expect(await a.directory.setUserRole("s", null)).toBe(true);
    expect(await a.ctx.internalAdapter.findUserById("s")).toMatchObject({ role: "guest" });
});

test("two mapped Better Auth instances share a database without crossing identities or requiring githubLogin", async () => {
    const a = await app(undefined, undefined, ["admin"], { prefix: "first" });
    const b = await app(undefined, undefined, ["admin"], { prefix: "second", db: a.sqlite });
    for (const instance of [a, b]) await instance.ctx.internalAdapter.createUser({ id: "member", email: "member@example.test", name: "Member", emailVerified: true, role: "approver" }, { method: "admin" });
    expect((await a.directory.listMembers()).items).toMatchObject([{ id: "member", role: "approver", githubLogin: null }]);
    await a.directory.setUserRole("member", "admin");
    await a.directory.setUserRole("member", null);
    expect(await a.ctx.internalAdapter.findUserById("member")).toMatchObject({ role: "approver" });
    expect(await b.ctx.internalAdapter.findUserById("member")).toMatchObject({ role: "approver" });
    await a.directory.deleteUser("member");
    expect(await b.ctx.internalAdapter.findUserById("member")).not.toBeNull();
    a.sqlite.run("UPDATE first_people SET roles='approver'");
    await d1BootstrapAdmin(a.d1, { match: "email", value: "s@example.test" }, a.auth)({ id: "s", email: "s@example.test", emailVerified: true });
    expect(await a.ctx.internalAdapter.findUserById("s")).toMatchObject({ role: "admin,approver" });
    expect((await b.directory.listUsers()).map(user => user.id)).toEqual(["s"]);
});
