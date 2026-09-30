import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { DatabaseDriver } from "../../src/core/index.js";
import { createMantleAuth, type CreateMantleAuthOptions } from "../../src/auth/index.js";

/**
 * Better Auth and Mantle over one real SQLite database, as a Worker has them over one D1: Better Auth gets the D1 shape the
 * preset hands it (Node 22.14's `node:sqlite` lacks what Better Auth's own node dialect needs).
 */
function sqlite() {
  const db = new DatabaseSync(":memory:");
  const exec = (sql: string, binds: readonly unknown[] = []) => {
    // Node 22's `node:sqlite` binds only anonymous `?`, so a numbered `?N` becomes `?` with its value in order
    const ordered: unknown[] = [];
    const text = sql.replace(/\?(\d+)/g, (_, n: string) => (ordered.push(binds[Number(n) - 1]), "?"));
    const values = (ordered.length ? ordered : binds).map((b) => (typeof b === "boolean" ? Number(b) : b)) as never[];
    const rows = db.prepare(text).all(...values) as Record<string, unknown>[];
    const { c, r } = db.prepare("SELECT changes() AS c, last_insert_rowid() AS r").get() as { c: number; r: number };
    return { rows, changes: c, lastRowId: r };
  };
  const statement = (sql: string, binds: unknown[] = []) => ({
    bind: (...b: unknown[]) => statement(sql, b),
    all: async () => { const { rows, changes, lastRowId } = exec(sql, binds); return { results: rows, success: true, meta: { changes, last_row_id: lastRowId } }; },
  });
  const tx = <T>(run: () => T): T => {
    db.exec("BEGIN");
    try { const out = run(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const d1 = {
    prepare: (sql: string) => statement(sql),
    exec: async (sql: string) => (db.exec(sql), { count: 0, duration: 0 }),
    batch: async (stmts: ReturnType<typeof statement>[]) => Promise.all(stmts.map((s) => s.all())),
  };
  const driver: DatabaseDriver = { batch: async (stmts) => tx(() => stmts.map((s) => exec(s.sql, s.binds))) };
  return { d1: d1 as unknown as CreateMantleAuthOptions["database"], driver };
}

it("staff management acts as the signed-in owner through Better Auth's admin API", async () => {
  const { d1, driver } = sqlite();
  const codes = new Map<string, string>();
  const auth = createMantleAuth({
    database: d1, driver, baseURL: "http://localhost", secret: "x".repeat(40), ipAddressHeaders: ["x-real-ip"],
    methods: [{ kind: "email-otp", sender: { send: async ({ to, text }) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }],
    bootstrapOwner: { match: "email", value: "owner@x.test" },
  });
  const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
    auth.handler(new Request(`http://localhost/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "x-real-ip": "1.1.1.1", ...headers }, body: JSON.stringify(body) }));
  const signIn = async (email: string) => {
    expect((await post("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20)); // the send is a background task
    const res = await post("/sign-in/email-otp", { email, otp: codes.get(email) });
    expect(res.status).toBe(200);
    return new Request("http://localhost/admin/api/staff", { headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } });
  };

  const owner = await signIn("owner@x.test");
  const [me] = await auth.listUsers(owner);
  expect(me).toMatchObject({ email: "owner@x.test", role: "owner", githubLogin: null, emailVerified: true });
  expect(me!.createdAt).toBeInstanceOf(Date);

  const invited = await auth.inviteUser(owner, " Ed@X.test ", "editor");
  expect(invited.kind).toBe("created");
  expect(await auth.inviteUser(owner, "ed@x.test", "contributor")).toEqual({ kind: "exists", id: invited.id });
  expect((await auth.listUsers(owner)).map((u) => [u.email, u.role, u.emailVerified])).toEqual([["owner@x.test", "owner", true], ["ed@x.test", "editor", false]]);

  expect(await auth.setUserRole(owner, invited.id, "contributor")).toBe(true);
  expect(await auth.getUserRole(invited.id)).toBe("contributor");
  expect(await auth.setUserRole(owner, invited.id, null)).toBe(true);
  expect(await auth.getUserRole(invited.id)).toBe("user"); // not a staff role
  expect((await auth.listUsers(owner)).map((u) => u.email)).toEqual(["owner@x.test"]);
  expect(await auth.setUserRole(owner, "ghost", "editor")).toBe(false);

  // Better Auth authorizes too: a signed-in non-staff user is refused, and so is no session at all
  const member = await signIn("member@x.test");
  await expect(auth.setUserRole(member, invited.id, "owner")).rejects.toMatchObject({ status: "FORBIDDEN" });
  await expect(auth.listUsers(new Request("http://localhost/"))).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  await expect(auth.inviteUser(member, "x@x.test", "owner")).rejects.toMatchObject({ status: "FORBIDDEN" });

  // Better Auth pages 100 users at a time; the staff list is every one of them
  const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
  await driver.batch(Array.from({ length: 120 }, (_, i) => ({ sql: "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?1, ?1, ?2, 0, ?3, ?3, 'contributor')", binds: [`bulk${i}`, `bulk${i}@x.test`, at] })));
  expect(await auth.listUsers(owner)).toHaveLength(121);

  expect(await auth.deleteUser(invited.id)).toBe(true);
  expect(await auth.deleteUser(invited.id)).toBe(false);
});

it("the statements Better Auth has no call for run on a real database: members, invites, linked accounts, consents", async () => {
  const { d1, driver } = sqlite();
  const auth = createMantleAuth({
    database: d1, driver, baseURL: "http://localhost", secret: "x".repeat(40), ipAddressHeaders: ["x-real-ip"],
    methods: [{ kind: "email-otp", sender: { send: async () => {} } }],
    oauthProvider: { loginPage: "/admin/sign-in", consentPage: "/oauth/consent", scopes: ["mcp"], mcpResource: "http://localhost/mcp" },
  });
  await auth.listOAuthConsents!("u"); // prepares Better Auth's tables
  const at = (d: number) => new Date(Date.UTC(2026, 0, d)).toISOString();
  const sql = (s: string, ...binds: unknown[]) => driver.batch([{ sql: s, binds }]);
  const user = (id: string, email: string, verified: number, role: string | null, day: number) =>
    sql('INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt") VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?5)', id, email, verified, role, at(day));
  await user("boss", "boss@x.test", 1, "owner", 1);
  await user("m1", "one@x.test", 1, null, 2);
  await user("m2", "two@x.test", 1, "user", 3);
  await user("inv", "inv@x.test", 0, "editor", 4);
  await sql('INSERT INTO account (id, "accountId", "providerId", "userId", issuer, "createdAt", "updatedAt") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)', "a1", "gh1", "github", "m1", "https://github.com", at(5));

  // members: everyone but staff, in creation order, searched and paged by cursor
  const page1 = await auth.listMembers({ limit: 1 });
  expect([page1.items.map((m) => m.email), page1.items[0]!.emailVerified]).toEqual([["one@x.test"], true]);
  expect((await auth.listMembers({ limit: 1, cursor: page1.nextCursor! })).items.map((m) => m.email)).toEqual(["two@x.test"]);
  expect((await auth.listMembers({ limit: 10, search: "TWO" })).items.map((m) => m.id)).toEqual(["m2"]);
  expect(await auth.getUser("m1")).toMatchObject({ email: "one@x.test", emailVerified: true, githubLogin: null });

  // linked accounts, and an invite that nobody signed in to is the only user revokeInvite deletes
  expect((await auth.listLinkedAccounts("m1")).map((a) => a.providerId)).toEqual(["github"]);
  expect([await auth.unlinkAccount("m1", "google"), await auth.unlinkAccount("m1", "github"), await auth.listLinkedAccounts("m1")]).toEqual([false, true, []]);
  expect([await auth.revokeInvite("m1"), await auth.revokeInvite("inv"), await auth.getUser("inv")]).toEqual([false, true, null]);

  // a consent: its tokens are revoked, its pending codes and the consent deleted; another client's and an OTP stay
  for (const [id, client, name] of [["cl1", "c1", "Client One"], ["cl2", "c2", null]] as const)
    await sql('INSERT INTO "oauthClient" (id, "clientId", name, "redirectUris") VALUES (?1, ?2, ?3, ?4)', id, client, name, "[]");
  for (const [id, client] of [["k1", "c1"], ["k2", "c2"]] as const)
    await sql('INSERT INTO "oauthConsent" (id, "clientId", "userId", scopes, "createdAt", "updatedAt") VALUES (?1, ?2, ?3, ?4, ?5, ?5)', id, client, "m1", '["mcp"]', at(6));
  for (const [id, client] of [["t1", "c1"], ["t2", "c2"]] as const) {
    await sql('INSERT INTO "oauthAccessToken" (id, token, "clientId", "userId", "expiresAt", "createdAt", scopes) VALUES (?1, ?1, ?2, ?3, ?4, ?4, ?5)', id, client, "m1", at(9), '["mcp"]');
    await sql('INSERT INTO "oauthRefreshToken" (id, token, "clientId", "userId", "expiresAt", "createdAt", scopes) VALUES (?1, ?1, ?2, ?3, ?4, ?4, ?5)', `r${id}`, client, "m1", at(9), '["mcp"]');
  }
  const code = (client: string, user = "m1") => JSON.stringify({ type: "authorization_code", userId: user, query: { client_id: client } });
  for (const [id, value] of [["v1", code("c1")], ["v2", code("c2")], ["v3", code("c1", "m2")], ["v4", '{"otp":"123456","userId":"m1"}']] as const)
    await sql("INSERT INTO verification (id, identifier, value, \"expiresAt\", \"createdAt\", \"updatedAt\") VALUES (?1, ?1, ?2, ?3, ?3, ?3)", id, value, at(9));
  // 120 rows that match the scan but are not a code of this grant sort before it: the sweep pages past them
  for (let i = 0; i < 120; i++)
    await sql("INSERT INTO verification (id, identifier, value, \"expiresAt\", \"createdAt\", \"updatedAt\") VALUES (?1, ?1, ?2, ?3, ?3, ?3)", `p${String(i).padStart(3, "0")}`, JSON.stringify({ type: "other", userId: "m1", query: { client_id: "c1" } }), at(9));
  expect(await auth.listOAuthConsents!("m1")).toEqual([
    { id: "k1", clientId: "c1", clientName: "Client One", scopes: ["mcp"] }, { id: "k2", clientId: "c2", clientName: "c2", scopes: ["mcp"] },
  ].sort((a, b) => (a.id < b.id ? -1 : 1)));
  expect([await auth.revokeOAuthConsent!("m2", "k1"), await auth.revokeOAuthConsent!("m1", "k1")]).toEqual([false, true]);
  const col = async (s: string) => (await sql(s))[0]!.rows.map((r) => Object.values(r).join(":"));
  expect(await col('SELECT id FROM "oauthConsent" ORDER BY id')).toEqual(["k2"]);
  expect(await col("SELECT id FROM verification WHERE id LIKE 'v%' ORDER BY id")).toEqual(["v2", "v3", "v4"]);
  expect(await col("SELECT count(*) FROM verification WHERE id LIKE 'p%'")).toEqual(["120"]);
  expect(await col('SELECT id, revoked IS NOT NULL FROM "oauthAccessToken" ORDER BY id')).toEqual(["t1:1", "t2:0"]);
  expect(await col('SELECT id, revoked IS NOT NULL FROM "oauthRefreshToken" ORDER BY id')).toEqual(["rt1:1", "rt2:0"]);
});

it("two isolates preparing a fresh database at once both succeed; a prepared one skips Better Auth's introspection", async () => {
  const { d1, driver } = sqlite();
  let statements = 0;
  const counted: typeof driver = { batch: async (s) => ((statements += s.length), driver.batch(s)) };
  // every statement yields first, so the two isolates' introspection and table creation interleave
  type St = { bind: (...b: unknown[]) => St; all: () => Promise<unknown> };
  const slowSt = (st: St): St => ({ bind: (...b) => slowSt(st.bind(...b)), all: async () => (await new Promise((r) => setTimeout(r, 2)), st.all()) });
  const raw = d1 as unknown as { prepare: (sql: string) => St; batch: (x: St[]) => Promise<unknown> };
  const slow = { ...raw, prepare: (sql: string) => slowSt(raw.prepare(sql)), batch: (x: St[]) => Promise.all(x.map((st) => st.all())) } as unknown as typeof d1;
  const make = () => createMantleAuth({ database: slow, driver: counted, baseURL: "http://localhost", secret: "x".repeat(40), ipAddressHeaders: ["x-real-ip"], methods: [{ kind: "email-otp", sender: { send: async () => {} } }] });
  await driver.batch([{ sql: "CREATE TABLE _mantle_boot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)" }]);
  const settled = await Promise.allSettled([make().listMembers({ limit: 1 }), make().listMembers({ limit: 1 })]);
  expect(settled.map((r) => (r.status === "rejected" ? String(r.reason) : r.status))).toEqual(["fulfilled", "fulfilled"]);
  statements = 0;
  await make().listMembers({ limit: 1 });
  expect(statements).toBe(2); // the digest read, then the members query
});
