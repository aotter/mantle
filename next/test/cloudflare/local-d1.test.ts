import { afterAll, beforeAll, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";

let d1: LocalD1;
beforeAll(async () => {
  d1 = await LocalD1.create();
  await d1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 0))");
}, 60_000);
afterAll(() => d1.dispose());

it("has the SQLite features ADR-0034 relies on (sqlite_version() itself is not allowlisted)", async () => {
  expect(await d1.all(`SELECT concat('a', 'b') AS c, string_agg('x', ',') AS s, json_extract(jsonb('{"a":1}'), '$.a') AS j`)).toEqual([{ c: "ab", s: "x", j: 1 }]);
});

it("a batch is all or nothing and changes() counts inside it", async () => {
  await expect(d1.batch([{ sql: "INSERT INTO t (n) VALUES (1)" }, { sql: "INSERT INTO t (n) VALUES (-1)" }])).rejects.toThrow();
  expect(await d1.all("SELECT count(*) AS c FROM t")).toEqual([{ c: 0 }]);
  const [ins] = await d1.batch([{ sql: "INSERT INTO t (n) VALUES (?1)", binds: [5] }]);
  expect(ins!.changes).toBe(1);
});
