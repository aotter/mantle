import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { DatabaseDriver } from "../../src/core/index.js";
import { createMantleAuth, type CreateMantleAuthOptions } from "../../src/auth/createMantleAuth.js";

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
