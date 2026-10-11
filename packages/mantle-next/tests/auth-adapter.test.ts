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
import { authSchemaSql } from "../src/auth/schema.js";

// The official suite is written for vitest: `test.skipIf(c)(name, { timeout }, ({ onTestFailed, skip }) => ...)`. Bun maps the
// "vitest" import to bun:test, which passes no such context, so wrap that one call shape to supply it (`skip` only returns
// early; the suite's own `return` follows it).
type Context = { onTestFailed(hook: () => unknown): void; skip(reason?: string): void };
const skipIf = bunTest.test.skipIf;
(bunTest.test as { skipIf: unknown }).skipIf = (condition: unknown) => {
  const register = skipIf.call(bunTest.test, !!condition) as (...args: unknown[]) => void;
  return (name: string, options: unknown, fn?: (context: Context) => Promise<void>) => {
    if (!fn) return register(name, options);
    return register(name, async () => {
      const hooks: (() => unknown)[] = [];
      try { await fn({ onTestFailed: hook => void hooks.push(hook), skip: () => {} }); } catch (error) { for (const hook of hooks) await hook(); throw error; }
    }, (options as { timeout?: number }).timeout);
  };
};
const { authFlowTestSuite, caseInsensitiveTestSuite, joinsTestSuite, normalTestSuite, numberIdTestSuite, testAdapter, transactionsTestSuite, uuidTestSuite } = await import("@better-auth/test-utils/adapter");

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
const suites = [normalTestSuite({ disableTests }), transactionsTestSuite(), authFlowTestSuite(), caseInsensitiveTestSuite(), joinsTestSuite({ disableTests }), uuidTestSuite({ disableTests }), numberIdTestSuite({ disableTests })];

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

/** consumeOne guards OTP consumption and incrementOne attempt counting: one statement, at most one winner. */
function atomicity(label: string, setup: () => Promise<{ adapter: ReturnType<ReturnType<typeof d1Adapter>>; done?: () => Promise<void> }>, enabled = true) {
  describe.skipIf(!enabled)(`${label}: single-statement guards`, () => {
    test("the same code consumed twice concurrently succeeds once", async () => {
      const { adapter, done } = await setup();
      await adapter.create({ model: "verification", data: { identifier: "otp:a@b.c", value: "123456", expiresAt: new Date(Date.now() + 60_000) } });
      const where = [{ field: "identifier", value: "otp:a@b.c" }];
      const results = await Promise.all([adapter.consumeOne({ model: "verification", where }), adapter.consumeOne({ model: "verification", where })]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await adapter.count({ model: "verification" })).toBe(0);
      await done?.();
    });
    test("consumeOne deletes at most one of several matching rows", async () => {
      const { adapter, done } = await setup();
      for (const value of ["1", "2", "3"]) await adapter.create({ model: "verification", data: { identifier: "same", value, expiresAt: new Date(Date.now() + 60_000) } });
      expect(await adapter.consumeOne({ model: "verification", where: [{ field: "identifier", value: "same" }] })).not.toBeNull();
      expect(await adapter.count({ model: "verification" })).toBe(2);
      await done?.();
    });
    test("incrementOne with a guard counts each attempt once", async () => {
      const { adapter, done } = await setup();
      await adapter.create({ model: "rateLimit", data: { key: "k", count: 0, lastRequest: 1 } });
      const attempt = () => adapter.incrementOne({ model: "rateLimit", where: [{ field: "key", value: "k" }, { field: "count", operator: "lt", value: 1 }], increment: { count: 1 } });
      const results = await Promise.all([attempt(), attempt(), attempt()]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await adapter.findOne<{ count: number }>({ model: "rateLimit", where: [{ field: "key", value: "k" }] })).toMatchObject({ count: 1 });
      await done?.();
    });
  });
}

/** Behaviour of the native SQL itself: number fields, join projection, per-parent join limits. */
function sql(label: string, setup: (options: BetterAuthOptions) => Promise<{ adapter: ReturnType<ReturnType<typeof d1Adapter>>; done?: () => Promise<void> }>, enabled = true) {
  const joinOptions: BetterAuthOptions = { rateLimit: { storage: "database" }, advanced: { database: { joins: true } } };
  describe.skipIf(!enabled)(`${label}: native SQL behaviour`, () => {
    test("a bigint number field round-trips as a JS number", async () => {
      const { adapter, done } = await setup(joinOptions);
      const lastRequest = Date.now();
      await adapter.create({ model: "rateLimit", data: { key: "k", count: 1, lastRequest } });
      const row = await adapter.findOne<{ lastRequest: number; count: number }>({ model: "rateLimit", where: [{ field: "key", value: "k" }] });
      expect(typeof row!.lastRequest).toBe("number");
      expect(row!.lastRequest + 1000 - lastRequest).toBe(1000);
      expect(typeof row!.count).toBe("number");
      await done?.();
    });
    test("select with join keeps the id, join key and sort column in the primary query", async () => {
      const { adapter, done } = await setup(joinOptions);
      const expiresAt = new Date(Date.now() + 60_000);
      for (const email of ["b@x.io", "a@x.io"]) {
        const user = await adapter.create<{ id: string }>({ model: "user", data: { name: email, email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
        for (let i = 0; i < 2; i++) await adapter.create({ model: "session", data: { token: `${email}${i}`, userId: user.id, expiresAt, createdAt: new Date(), updatedAt: new Date() } });
      }
      const rows = await adapter.findMany<{ name: string; email?: string; session: unknown[] }>({ model: "user", select: ["name"], sortBy: { field: "email", direction: "asc" }, limit: 10, join: { session: true } });
      expect(rows.map(r => r.name)).toEqual(["a@x.io", "b@x.io"]);
      expect(rows.map(r => r.session.length)).toEqual([2, 2]);
      expect(rows[0]!.email).toBeUndefined();
      await done?.();
    });
    test("a one-to-many join returns at most `limit` rows per parent, chosen in SQL", async () => {
      const { adapter, done } = await setup(joinOptions);
      const expiresAt = new Date(Date.now() + 60_000);
      const make = async (email: string, sessions: number) => {
        const user = await adapter.create<{ id: string }>({ model: "user", data: { name: email, email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
        for (let i = 0; i < sessions; i++) await adapter.create({ model: "session", data: { token: `${email}${i}`, userId: user.id, expiresAt, createdAt: new Date(), updatedAt: new Date() } });
      };
      await make("many@x.io", 7);
      await make("few@x.io", 2);
      await make("none@x.io", 0);
      const rows = await adapter.findMany<{ email: string; session: unknown[] }>({ model: "user", sortBy: { field: "email", direction: "asc" }, limit: 10, join: { session: { limit: 3 } } });
      expect(rows.map(r => [r.email, r.session.length])).toEqual([["few@x.io", 2], ["many@x.io", 3], ["none@x.io", 0]]);
      await done?.();
    });
  });
}
sql("D1", async options => {
  resetSqlite(options);
  return { adapter: d1Adapter(d1)(options) };
});
sql("Bun.SQL", async options => {
  const pg = await pgSchema();
  await pg.reset(options);
  return { adapter: bunSqlAdapter(pg.sql)(options) as never, done: pg.drop };
}, !!pgUrl);

test("delete of a missing row resolves", async () => {
  resetSqlite({});
  await d1Adapter(d1)({}).delete({ model: "user", where: [{ field: "id", value: "missing" }] });
});

const options: BetterAuthOptions = { rateLimit: { storage: "database" } };
atomicity("D1", async () => {
  resetSqlite(options);
  return { adapter: d1Adapter(d1)(options) };
});
atomicity("Bun.SQL", async () => {
  const pg = await pgSchema();
  await pg.reset(options);
  return { adapter: bunSqlAdapter(pg.sql)(options) as never, done: pg.drop };
}, !!pgUrl);
