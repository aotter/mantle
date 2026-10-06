/** Better Auth and Mantle's auth SQL over one PostgreSQL database, as a Worker has them over Hyperdrive. */
import { expect, it } from "vitest";
import { createMantleAuth, type CreateMantleAuthOptions } from "../../src/auth/index.js";
import { pgDatabaseDriver, pgPool } from "../../src/postgres/index.js";
import { PG_URL, freshSchema } from "./engine.js";

it.skipIf(!PG_URL)("sign-in, the bootstrap owner and staff management run on PostgreSQL", async () => {
  const { connect, drop } = await freshSchema();
  try {
    const codes = new Map<string, string>();
    const config = {
      database: pgPool(connect), driver: pgDatabaseDriver(connect), baseURL: "http://localhost", secret: "x".repeat(40), ipAddressHeaders: ["x-real-ip"],
      methods: [{ kind: "email-otp", sender: { send: async ({ to, text }) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }],
      bootstrapOwner: { match: "email", value: "owner@x.test" },
    } satisfies CreateMantleAuthOptions;
    const auth = createMantleAuth(config);
    const post = (path: string, body: unknown) =>
      auth.handler(new Request(`http://localhost/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "x-real-ip": "1.1.1.1" }, body: JSON.stringify(body) }));
    const signIn = async (email: string) => {
      expect((await post("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 50)); // the send is a background task
      const res = await post("/sign-in/email-otp", { email, otp: codes.get(email) });
      expect(res.status).toBe(200);
      return new Request("http://localhost/admin/api/staff", { headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } });
    };

    const owner = await signIn("owner@x.test");
    const [me] = await auth.listUsers(owner);
    expect(me).toMatchObject({ email: "owner@x.test", role: "owner", emailVerified: true });

    const invited = await auth.inviteUser(owner, "ed@x.test", "editor");
    expect(invited.kind).toBe("created");
    expect((await auth.listUsers(owner)).map((u) => [u.email, u.role])).toEqual([["owner@x.test", "owner"], ["ed@x.test", "editor"]]);
    expect(await auth.setUserRole(owner, invited.id, "contributor")).toBe(true);
    expect(await auth.getUserRole(invited.id)).toBe("contributor");

    const member = await signIn("member@x.test");
    const session = await auth.getSession(member);
    expect(session!.session.createdAt).toBeInstanceOf(Date);
    expect(session!.session.expiresAt).toBeInstanceOf(Date);
    const db = pgDatabaseDriver(connect);
    await db.batch(["sign-in", "email-verification", "forget-password"].map((type) => ({
      sql: `INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt") VALUES (?1, ?2, ?3, now() + interval '1 hour', now(), now())`,
      binds: [type, `${type}-otp-member@x.test`, "pending"],
    })));
    await expect(auth.setUserRole(member, invited.id, "owner")).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(await auth.getUserRole((await auth.listUsers(owner))[0]!.id)).toBe("owner");
    expect(await auth.deleteUser(session!.user.id)).toBe(true);
    expect((await db.batch([{ sql: "SELECT identifier FROM verification WHERE identifier LIKE ?1", binds: ["%member@x.test"] }]))[0]!.rows).toEqual([]);
    expect(await auth.getSession(member)).toBeNull();

    // The old 1.7.0–1.7.2 column must remain intact but become nullable.
    // Simulate that populated legacy auth schema and exercise the documented
    // PostgreSQL migration, with an existing real owner's session.
    await db.batch([
      { sql: 'ALTER TABLE account ADD COLUMN issuer text NOT NULL DEFAULT \'https://legacy.example\'' },
      { sql: 'ALTER TABLE account ALTER COLUMN issuer DROP DEFAULT' },
      { sql: 'INSERT INTO account (id, "accountId", "providerId", "userId", issuer, "createdAt", "updatedAt") VALUES (\'legacy-account\', \'legacy-owner\', \'legacy-provider\', ?1, \'https://legacy.example\', now(), now())', binds: [me!.id] },
    ]);
    const legacyAccounts = (await db.batch([{ sql: 'SELECT * FROM account ORDER BY id' }]))[0]!.rows;
    const legacyUsers = (await db.batch([{ sql: 'SELECT * FROM "user" ORDER BY id' }]))[0]!.rows;
    await expect(createMantleAuth(config).getSession(owner)).rejects.toThrow(/schema mismatch/i);
    // A driver's batch is transactional; the documented SQL keeps all values.
    await db.batch([{ sql: 'ALTER TABLE account ALTER COLUMN issuer DROP NOT NULL' }]);
    const upgraded = createMantleAuth(config);
    expect((await upgraded.getSession(owner))!.user.id).toBe(me!.id);
    expect((await upgraded.listUsers(owner))[0]!.role).toBe("owner");
    expect((await db.batch([{ sql: 'SELECT * FROM account ORDER BY id' }]))[0]!.rows).toEqual(legacyAccounts);
    expect((await db.batch([{ sql: 'SELECT * FROM "user" ORDER BY id' }]))[0]!.rows).toEqual(legacyUsers);
  } finally {
    await drop();
  }
}, 120_000);

it.skipIf(!PG_URL)("an OAuth grant stored in jsonb (Better Auth's PostgreSQL schema) is read as the token's active grant", async () => {
  const { assertActiveUserGrant } = await import("../../src/auth/oauthTokens.js");
  const { connect, drop } = await freshSchema();
  try {
    const db = pgDatabaseDriver(connect);
    await db.batch([
      { sql: 'CREATE TABLE session (id text PRIMARY KEY, "userId" text NOT NULL, "expiresAt" timestamptz NOT NULL)' },
      { sql: 'CREATE TABLE "oauthConsent" (id text PRIMARY KEY, "clientId" text NOT NULL, "userId" text NOT NULL, scopes jsonb NOT NULL, resources jsonb)' },
      { sql: "INSERT INTO session VALUES ('s1', 'u1', now() + interval '1 hour')" },
      { sql: `INSERT INTO "oauthConsent" VALUES ('c1', 'app', 'u1', '["mcp", "offline_access"]', '["https://x.test/mcp"]')` },
    ]);
    const claims = { sub: "u1", azp: "app", sid: "s1", mantle_consent_id: "c1", scope: "mcp" };
    await expect(assertActiveUserGrant(db, claims, "https://x.test/mcp")).resolves.toBeUndefined();
    await expect(assertActiveUserGrant(db, claims, "https://other.test/mcp")).rejects.toThrow(/no longer active/);
    await expect(assertActiveUserGrant(db, { ...claims, scope: "mcp admin" }, "https://x.test/mcp")).rejects.toThrow(/no longer active/);
  } finally {
    await drop();
  }
});

it("the structural auth pool includes Kysely pool options", () => {
  expect(pgPool(async () => { throw new Error("not called"); }).options).toEqual({});
});
