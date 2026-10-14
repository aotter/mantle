/**
 * Better Auth's official adapter suite (`@better-auth/test-utils/adapter`) against the native adapters:
 * D1 (a bun:sqlite-backed D1 shim) and Bun.SQL PostgreSQL (when MANTLE_NEXT_BUN_PG_URL is set).
 */
import * as bunTest from "bun:test";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import type { BetterAuthOptions } from "@better-auth/core";
import { bunSqlAdapter, d1Adapter } from "../src/auth/adapter.js";
import { d1Shim } from "./apps/d1-shim.js";
import { authSchemaSql } from "../src/infrastructure/authSchema.js";

// The official suite is written for vitest: `test.skipIf(c)(name, { timeout }, ({ onTestFailed, skip }) => ...)`. Bun maps the
// "vitest" import to bun:test, which passes no such context, so wrap that one call shape to supply it (`skip` only returns
// early; the suite's own `return` follows it).
type Context = { onTestFailed(hook: () => unknown): void; skip(reason?: string): void };
const skipIf = bunTest.test.skipIf;
(bunTest.test as { skipIf: unknown }).skipIf = (condition: unknown) => {
  const register = skipIf.call(bunTest.test, !!condition) as (...args: unknown[]) => void;
  return (name: string, options: unknown, fn?: ((context: Context) => Promise<void>) | number) => {
    if (typeof fn !== "function") return register(name, options, fn);
    return register(name, async () => {
      const hooks: (() => unknown)[] = [];
      try { await fn({ onTestFailed: hook => void hooks.push(hook), skip: () => {} }); } catch (error) { for (const hook of hooks) await hook(); throw error; }
    }, (options as { timeout?: number }).timeout);
  };
};
const { authFlowTestSuite, caseInsensitiveTestSuite, createTestSuite, getNormalTestSuiteTests, testAdapter, transactionsTestSuite } = await import("@better-auth/test-utils/adapter");

const sqlite = new Database(":memory:");
sqlite.run("PRAGMA foreign_keys = ON");
const d1 = d1Shim(sqlite);
const resetSqlite = (options: BetterAuthOptions) => {
  sqlite.run("PRAGMA foreign_keys = OFF");
  for (const { name } of sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) sqlite.run(`DROP TABLE "${name}"`);
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const statement of authSchemaSql(options, "sqlite")) sqlite.run(statement);
};

// bun's `expect(promise).resolves.not.toThrow()` fails on a promise that resolves to undefined (vitest accepts it), so that one
// assertion is covered by the "delete of a missing row" test below instead.
const disableTests = { "delete - should not throw on record not found": true };
// Joins exercise the same CRUD contract; ID formats need only their own round-trip below.
const crud = createTestSuite("native CRUD", {
  defaultBetterAuthOptions: { advanced: { database: { joins: true } } },
  alwaysMigrate: true,
}, helpers => {
  const tests = getNormalTestSuiteTests(helpers);
  // The combined cases retain these same predicates/projections and check their interaction.
  for (const name of [
    "create - should always return an id",
    "findOne - should find a model",
    "findOne - should find a model with join",
    "findOne - should select fields with one-to-many join",
    "findOne - should select fields with one-to-one join",
    "findOne - should return an object for one-to-one joins",
    "findOne - should return an array for one-to-many joins",
    "findOne - should be able to perform a limited join",
    "findMany - should find many models",
    "findMany - should find many models with join",
    "findMany - should find many with join and limit",
    "findMany - should select fields with one-to-many join",
    "findMany - should select fields with one-to-one join",
    "findMany - should find many with join and offset",
    "findMany - should find many with join and sortBy",
    "findMany - should find many with join and where clause",
    "findMany - should find many with one-to-one join",
    "findMany - should find many models with contains operator",
    "findMany - should find many models with limit",
    "findMany - should find many models with offset",
    "findMany - should find many models with limit and offset",
    "findMany - should find many models with sortBy and offset",
    "findMany - should find many models with sortBy and limit",
    "findMany - should find many models with sortBy and limit and offset",
    "findMany - should be able to perform a limited join",
    "update - should update a model",
    "update - should work when updated field is not in where clause",
  ] as const) delete tests[name];
  return tests;
});
const suites = [crud({ disableTests }), transactionsTestSuite(), authFlowTestSuite(), caseInsensitiveTestSuite()];

(await testAdapter({ adapter: () => d1Adapter(d1), runMigrations: resetSqlite, tests: suites })).execute();

const pgUrl = process.env.MANTLE_NEXT_BUN_PG_URL;
test.skipIf(!pgUrl)("Bun.SQL PostgreSQL official suite (set MANTLE_NEXT_BUN_PG_URL)", () => {});

/**
 * A fresh schema per run on `search_path`, dropped after. Bun.SQL caches prepared statements by text with the parameter
 * types the server inferred, so a pool that outlives a schema reset reuses stale plans: every reset gets a new pool.
 */
async function pgSchema() {
  const name = `auth_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(pgUrl!);
  await admin.unsafe(`CREATE SCHEMA "${name}"`, []);
  const pool = () => new SQL({ url: pgUrl!, connection: { search_path: name }, max: 4 });
  const fixture = {
    sql: pool(),
    reset: async (options: BetterAuthOptions) => {
      await fixture.sql.close();
      await admin.unsafe(`DROP SCHEMA "${name}" CASCADE`, []);
      await admin.unsafe(`CREATE SCHEMA "${name}"`, []);
      fixture.sql = pool();
      for (const statement of authSchemaSql(options, "postgres")) await fixture.sql.unsafe(statement, []);
    },
    drop: async () => { await fixture.sql.close(); await admin.unsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`, []); await admin.close(); },
  };
  return fixture;
}

if (pgUrl) {
  const pg = await pgSchema();
  (await testAdapter({ adapter: () => bunSqlAdapter(pg.sql), runMigrations: pg.reset, tests: suites, onFinish: pg.drop })).execute();
}

type Adapter = ReturnType<ReturnType<typeof d1Adapter>>;
/** One database per test (a bun:sqlite D1 shim, or a fresh PostgreSQL schema) with the adapter built for `options`. */
const backends: [label: string, setup: (options: BetterAuthOptions) => Promise<{ adapter: Adapter; done?: () => Promise<void> }>, enabled: boolean][] = [
  ["D1", async options => { resetSqlite(options); return { adapter: d1Adapter(d1)(options) }; }, true],
  ["Bun.SQL", async options => { const pg = await pgSchema(); await pg.reset(options); return { adapter: bunSqlAdapter(pg.sql)(options) as never, done: pg.drop }; }, !!pgUrl],
];
const expiresAt = () => new Date(Date.now() + 60_000);
const makeUser = (adapter: Adapter, email: string, sessions = 0) => adapter.create<{ id: string }>({ model: "user", data: { name: email, email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } }).then(async user => {
  for (let i = 0; i < sessions; i++) await adapter.create({ model: "session", data: { token: `${email}${i}`, userId: user.id, expiresAt: expiresAt(), createdAt: new Date(), updatedAt: new Date() } });
  return user;
});

for (const [label, setup, enabled] of backends) describe.skipIf(!enabled)(`${label}: native SQL`, () => {
  const rateLimit: BetterAuthOptions = { rateLimit: { storage: "database" } };
  const joins: BetterAuthOptions = { ...rateLimit, advanced: { database: { joins: true } } };
  /** Runs `body` on a fresh database and always drops it. */
  const run = (options: BetterAuthOptions, body: (adapter: Adapter) => Promise<void>) => async () => { const { adapter, done } = await setup(options); try { await body(adapter); } finally { await done?.(); } };

  test("UUID and serial IDs retain their format through a native lookup", async () => {
    for (const generateId of ["uuid", "serial"] as const) {
      const { adapter, done } = await setup({ advanced: { database: { generateId } } });
      try {
        const user = await makeUser(adapter, `${generateId}@x.io`);
        expect(user.id).toMatch(generateId === "uuid" ? /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i : /^[1-9]\d*$/);
        expect(await adapter.findOne({ model: "user", where: [{ field: "id", value: user.id }] })).toMatchObject({ id: user.id });
      } finally { await done?.(); }
    }
  });

  // consumeOne guards OTP consumption and incrementOne attempt counting: one statement, at most one winner.
  test("the same code consumed twice concurrently succeeds once", run(rateLimit, async adapter => {
    await adapter.create({ model: "verification", data: { identifier: "otp:a@b.c", value: "123456", expiresAt: expiresAt() } });
    const where = [{ field: "identifier", value: "otp:a@b.c" }];
    const results = await Promise.all([adapter.consumeOne({ model: "verification", where }), adapter.consumeOne({ model: "verification", where })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await adapter.count({ model: "verification" })).toBe(0);
  }));
  test("consumeOne deletes at most one of several matching rows", run(rateLimit, async adapter => {
    for (const value of ["1", "2", "3"]) await adapter.create({ model: "verification", data: { identifier: "same", value, expiresAt: expiresAt() } });
    expect(await adapter.consumeOne({ model: "verification", where: [{ field: "identifier", value: "same" }] })).not.toBeNull();
    expect(await adapter.count({ model: "verification" })).toBe(2);
  }));
  test("incrementOne with a guard counts each attempt once", run(rateLimit, async adapter => {
    await adapter.create({ model: "rateLimit", data: { key: "k", count: 0, lastRequest: 1 } });
    const attempt = () => adapter.incrementOne({ model: "rateLimit", where: [{ field: "key", value: "k" }, { field: "count", operator: "lt", value: 1 }], increment: { count: 1 } });
    expect((await Promise.all([attempt(), attempt(), attempt()])).filter(Boolean)).toHaveLength(1);
    expect(await adapter.findOne<{ count: number }>({ model: "rateLimit", where: [{ field: "key", value: "k" }] })).toMatchObject({ count: 1 });
  }));

  // number fields, join projection, per-parent join limits
  test("a bigint number field round-trips as a JS number", run(joins, async adapter => {
    const lastRequest = Date.now();
    await adapter.create({ model: "rateLimit", data: { key: "k", count: 1, lastRequest } });
    const row = await adapter.findOne<{ lastRequest: number; count: number }>({ model: "rateLimit", where: [{ field: "key", value: "k" }] });
    expect(typeof row!.lastRequest).toBe("number");
    expect(row!.lastRequest + 1000 - lastRequest).toBe(1000);
    expect(typeof row!.count).toBe("number");
  }));
  test("select with join keeps the id, join key and sort column in the primary query", run(joins, async adapter => {
    for (const email of ["b@x.io", "a@x.io"]) await makeUser(adapter, email, 2);
    const rows = await adapter.findMany<{ name: string; email?: string; session: unknown[] }>({ model: "user", select: ["name"], sortBy: { field: "email", direction: "asc" }, limit: 10, join: { session: true } });
    expect(rows.map(r => r.name)).toEqual(["a@x.io", "b@x.io"]);
    expect(rows.map(r => r.session.length)).toEqual([2, 2]);
    expect(rows[0]!.email).toBeUndefined();
  }));
  test("a one-to-many join returns at most `limit` rows per parent, chosen in SQL", run(joins, async adapter => {
    await makeUser(adapter, "many@x.io", 7);
    await makeUser(adapter, "few@x.io", 2);
    await makeUser(adapter, "none@x.io");
    const rows = await adapter.findMany<{ email: string; session: unknown[] }>({ model: "user", sortBy: { field: "email", direction: "asc" }, limit: 10, join: { session: { limit: 3 } } });
    expect(rows.map(r => [r.email, r.session.length])).toEqual([["few@x.io", 2], ["many@x.io", 3], ["none@x.io", 0]]);
  }));
  // the official suite's "should not throw on record not found" is disabled above: bun reads a promise resolving to undefined as a failure
  test("delete of a missing row resolves", run({}, async adapter => { await adapter.delete({ model: "user", where: [{ field: "id", value: "missing" }] }); }));
});
