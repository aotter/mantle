import { expect, it } from "vitest";
import { sqlite } from "./sqliteFixture.js";
import { createMantleAuth, type CreateMantleAuthOptions } from "../../src/auth/index.js";

it("checks an incompatible auth schema after convergence and refuses sessions even with a current ledger", async () => {
  const { d1, driver } = sqlite();
  const config = { database: d1, driver, baseURL: "http://localhost", secret: "x".repeat(40), ipAddressHeaders: ["x-real-ip"], methods: [{ kind: "email-otp" as const, sender: { send: async () => {} } }] };
  await driver.batch([{ sql: "CREATE TABLE _mantle_boot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)" }]);
  await createMantleAuth(config).listMembers({ limit: 1 });
  // Keep the ledger but remove the table, simulating out-of-band schema drift.
  await driver.batch([{ sql: "DROP TABLE session" }]);
  const auth = createMantleAuth(config);
  await auth.ready;
  await expect(auth.getSession(new Request("http://localhost"))).rejects.toThrow(/schema mismatch/i);
  await expect(auth.handler(new Request("http://localhost/api/auth/get-session"))).rejects.toThrow(/schema mismatch/i);
});


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

it("cached sessions retain sign-in dates and OTP cleanup can fail safely before user deletion", async () => {
  let rejectCleanup = false;
  const { d1, driver } = sqlite(() => rejectCleanup);
  await driver.batch([{ sql: "CREATE TABLE _mantle_boot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)" }, { sql: "INSERT INTO _mantle_boot_state VALUES ('instance', 'cache-test-store')" }]);
  const cache = new Map<string, string>();
  const codes = new Map<string, string>();
  const auth = createMantleAuth({
    database: d1, driver, baseURL: "http://localhost", secret: "x".repeat(40), ipAddressHeaders: ["x-real-ip"],
    sessionCache: { get: async (key) => cache.get(key) ?? null, set: async (key, value) => { cache.set(key, value); }, delete: async (key) => { cache.delete(key); } },
    methods: [{ kind: "email-otp", sender: { send: async ({ to, text }) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }],
  });
  let ip = 0; // one address per request: Better Auth rate-limits repeated sends
  const post = (path: string, body: unknown) =>
    auth.handler(new Request(`http://localhost/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "x-real-ip": `1.1.1.${++ip}` }, body: JSON.stringify(body) }));
  const send = async (email: string) => { expect((await post("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200); await new Promise((r) => setTimeout(r, 20)); };
  await send("member@x.test");
  const before = Date.now();
  const signedIn = await post("/sign-in/email-otp", { email: "member@x.test", otp: codes.get("member@x.test") });
  const request = new Request("http://localhost/", { headers: { cookie: signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } });
  const session = await auth.getSession(request);
  expect(cache.size).toBeGreaterThan(0);
  expect(session!.session.createdAt).toBeInstanceOf(Date);
  expect(session!.session.expiresAt).toBeInstanceOf(Date);
  expect(Math.abs(session!.session.createdAt.getTime() - before)).toBeLessThan(5_000);

  await send("Member@X.test"); // a new code requested after sign-in, never used
  const pending = async () => (await driver.batch([{ sql: "SELECT identifier FROM verification WHERE identifier LIKE ?1", binds: ["%member@x.test"] }]))[0]!.rows;
  expect(await pending()).toHaveLength(1);
  await send("other@x.test");
  rejectCleanup = true;
  await expect(auth.deleteUser(session!.user.id)).rejects.toThrow("injected OTP cleanup failure");
  expect((await driver.batch([{ sql: "SELECT id FROM user WHERE id = ?1", binds: [session!.user.id] }]))[0]!.rows).toHaveLength(1);
  expect(await pending()).toHaveLength(1);
  rejectCleanup = false;
  expect(await auth.deleteUser(session!.user.id)).toBe(true);
  expect(await pending()).toEqual([]);
  expect((await driver.batch([{ sql: "SELECT identifier FROM verification", binds: [] }]))[0]!.rows).toEqual([{ identifier: "sign-in-otp-other@x.test" }]);
  expect(await auth.getSession(request)).toBeNull();
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
  await sql('INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?1, ?2, ?3, ?4, ?5, ?5)', "a1", "gh1", "github", "m1", at(5));

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

it("dynamic registration takes a loopback-only client without application_type as native, and nothing else", async () => {
  const { d1, driver } = sqlite();
  const auth = createMantleAuth({
    database: d1, driver, baseURL: "http://localhost", secret: "x".repeat(40), ipAddressHeaders: ["x-real-ip"],
    methods: [{ kind: "email-otp", sender: { send: async () => {} } }],
    oauthProvider: { loginPage: "/sign-in", consentPage: "/oauth/consent", scopes: ["mcp"], mcpResource: "http://localhost/mcp",
      allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true, clientRegistrationDefaultScopes: ["mcp"] },
  });
  let ip = 0; // one address per request: Better Auth rate-limits registration
  const register = async (body: Record<string, unknown>) => {
    const res = await auth.handler(new Request("http://localhost/api/auth/oauth2/register", { method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", "x-real-ip": `10.0.0.${++ip}` }, body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() as { application_type?: string; error?: string } };
  };
  for (const [redirect, method] of [["http://localhost:8787/callback", "none"], ["http://127.0.0.1:8787/callback", "client_secret_post"], ["http://[::1]:33418/", undefined]] as const) {
    const created = await register({ redirect_uris: [redirect], ...(method ? { token_endpoint_auth_method: method } : {}) });
    expect([created.status, created.body.application_type], redirect).toEqual([201, "native"]);
  }
  expect((await register({ redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" })).status).toBe(201);
  for (const body of [
    { redirect_uris: ["http://localhost:8787/callback"], application_type: "web" },
    { redirect_uris: ["http://localhost/cb", "https://client.example/cb"] },
    { redirect_uris: ["http://client.example/cb"], token_endpoint_auth_method: "none" },
  ]) expect(await register(body), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: "invalid_redirect_uri" } });
});
