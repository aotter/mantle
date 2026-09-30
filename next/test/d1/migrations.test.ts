import { afterAll, beforeAll, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { readStoreInstanceId, runMigrations } from "../../src/d1/index.js";
import { splitSqlStatements } from "../../src/d1/migrations.js";
import { convergeStorage } from "../../src/d1/storage.js";

let d1: LocalD1;
beforeAll(async () => { d1 = await LocalD1.create(); }, 60_000);
afterAll(() => d1.dispose());

it("splits at semicolons outside strings, identifiers, comments and trigger bodies' quotes", () => {
  expect(splitSqlStatements(`CREATE TABLE "a;b" (x TEXT DEFAULT 'q;r'); -- c;d\n/* e;f */ INSERT INTO t VALUES ('it''s;');\nSELECT 1`)).toEqual([
    `CREATE TABLE "a;b" (x TEXT DEFAULT 'q;r')`, `-- c;d\n/* e;f */ INSERT INTO t VALUES ('it''s;')`, "SELECT 1"]);
  expect(() => splitSqlStatements("SELECT 'open")).toThrow(/Unterminated/);
});

it("applies a migration once, whole or not at all, and two isolates racing on it both succeed", async () => {
  const m = { id: "t:1", sql: "CREATE TABLE m1 (id TEXT PRIMARY KEY); INSERT INTO m1 VALUES ('a')" };
  await runMigrations(d1, [m]);
  await runMigrations(d1, [m]);
  expect(await d1.all("SELECT count(*) AS c FROM m1")).toEqual([{ c: 1 }]);
  await expect(runMigrations(d1, [{ id: "t:bad", sql: "CREATE TABLE m2 (id TEXT); INSERT INTO nope VALUES (1)" }])).rejects.toThrow();
  expect(await d1.all("SELECT name FROM sqlite_schema WHERE name = 'm2'")).toEqual([]); // rolled back
  const race = { id: "t:race", sql: "CREATE TABLE m3 (id TEXT)" };
  expect((await Promise.allSettled([runMigrations(d1, [race]), runMigrations(d1, [race])])).map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
});

it("the store has one instance id, minted at the first convergence and never changed", async () => {
  await expect(readStoreInstanceId(d1)).rejects.toThrow(/converged/);
  await convergeStorage(d1, {}, { fingerprint: "f1" });
  const id = await readStoreInstanceId(d1);
  await convergeStorage(d1, {}, { fingerprint: "f2" });
  expect([id.length > 10, await readStoreInstanceId(d1)]).toEqual([true, id]);
});
