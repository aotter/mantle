/** Exact independent values and native ordering; shared by the four official-host checks. */
import assert from "node:assert/strict";
import type { Caller } from "../src/kernel/contracts.js";
import { user } from "./apps/fixtures.js";

const integers = ["-9223372036854775808", "-9007199254740993", "-9007199254740991", "-1", "0", "1", "9007199254740991", "9007199254740993", "9007199254740994", "9223372036854775807"];
const ids = integers.map((_, i) => i === 7 ? "a" : i === 8 ? "b" : String(i));
const expected = integers.map(n => BigInt(n) >= -9007199254740991n && BigInt(n) <= 9007199254740991n ? Number(n) : n);
const owner = user("integer-a"), system: Caller = { kind: "system", reason: "integer parity" };
export const integerOptions = { handlers: { "integer-ref": async (ctx: any, input: { id: string }) => String((await ctx.store.collection("parity_integer").findById(input.id))?.n ?? "absent") } };

export function integerSeed(sqlite: boolean): string {
  const time = sqlite ? "1791763200000000" : "'2026-10-12T00:00:00Z'";
  const fields = "id,owner,n,other,optional,enabled,amount,version,created_at,updated_at,author_id";
  const rows = integers.map((n, i) => `('${ids[i]}','integer-a',${n},${integers.length - i},${i === 0 || i === integers.length - 1 ? n : "NULL"},${sqlite ? "1" : "true"},0.1,1,${time},${time},NULL)`);
  rows.push(`('foreign','integer-b',9007199254740993,0,NULL,${sqlite ? "0" : "false"},0.1,1,${time},${time},NULL)`);
  return `INSERT INTO parity_integer(${fields}) VALUES ${rows.join(",")};
INSERT INTO parity_parent(id,owner,slug,units,status,version,created_at,updated_at) VALUES ('parent','integer-a','shared',9007199254740993,'published',1,${time},${time});
INSERT INTO parity_child(id,owner,slug,locale,title,status,version,created_at,updated_at) VALUES ('child','integer-a','shared','en','translation','published',1,${time},${time});`;
}

export async function verifyIntegers(app: any, db: any, sqlite: boolean, native: (sql: string) => Promise<Record<string, any>[]>, pages: Record<string, Function>): Promise<{ checks: number }> {
  let checks = 0;
  for (const name of ["integer-order", "integer-ordinal", "integer-cte"]) {
    const rows = [...await app.views[name](db, owner, {})];
    assert.deepEqual(rows.map(r => r.id), ids, `${name}: unchanged native integer order`);
    assert.deepEqual(rows.map(r => r.n), expected, `${name}: exact scalar primitive parity`); checks++;
  }
  const base = [...await app.views["integer-order"](db, owner, {})];
  for (const [i, row] of base.entries()) {
    assert.equal(row.optional, i === 0 || i === integers.length - 1 ? integers[i] : null); assert.equal(row.version, 1);
    assert.equal(row.enabled, sqlite ? 1 : true); assert.equal(row.amount, 0.1);
  }
  checks++;
  assert.deepEqual([...await app.views["integer-shadow"](db, owner, {})].map(r => r.id), [...ids].reverse(), "output shadow keeps original input sort"); checks++;
  assert.deepEqual([...await app.views["integer-null-order"](db, owner, {})], await native("SELECT id,CAST(optional AS text) AS optional FROM parity_integer WHERE owner='integer-a' ORDER BY parity_integer.optional DESC NULLS LAST,id ASC"), "nullable order uses native numbers, not wire text"); checks++;
  assert.deepEqual([...await app.views["integer-minmax"](db, owner, {})], [{ lo: integers[0], hi: integers.at(-1) }]);
  assert.equal((await app.views["integer-sum"](db, owner, {}))[0].total, "18014398509481987"); checks += 2;
  const computed = (await app.views["integer-computed"](db, owner, {}))[0];
  assert.deepEqual(computed, (await native(`SELECT count(*) AS count,avg(other) AS average,${sqlite ? "42" : "CAST(42 AS int8)"} AS computed,${sqlite ? "1234" : "CAST('12.34' AS numeric(12,2))"} AS decimal FROM parity_integer WHERE owner='integer-a'`))[0], "COUNT/AVG/CAST/decimal stay native"); checks++;
  for (const name of ["integer-order", "integer-ordinal", "integer-cte", "integer-grouped"]) {
    const walked: unknown[] = []; let cursor: string | undefined;
    do { const page = await pages[name]!(db, owner, {}, { limit: 1, ...(cursor ? { cursor } : {}) }); walked.push(...page.rows.map((r: any) => name === "integer-grouped" ? r.lo : r.n)); cursor = page.nextCursor; assert.ok(walked.length <= expected.length); } while (cursor);
    assert.deepEqual(walked, expected, `${name}: exact native numeric cursor walk`); checks++;
  }
  const collection = app.store(db, owner, integerOptions).collection("parity_integer");
  assert.equal((await collection.findById("a")).n, integers[7]);
  assert.equal(await collection.findById("foreign"), null);
  const walked: unknown[] = []; let cursor: string | null = null;
  do { const page: { rows: any[]; cursor: string | null } = await collection.find({ orderBy: "n", limit: 1, ...(cursor ? { cursor } : {}) }); walked.push(...page.rows.map(r => r.n)); cursor = page.cursor; assert.ok(walked.length <= expected.length); } while (cursor);
  assert.deepEqual(walked, expected, "Store preserves order and unsafe cursor"); checks += 3;
  const changed = await collection.update("a", { other: 3 }, { lock: 1 });
  assert.equal(changed.n, integers[7]); assert.equal(changed.version, 2);
  const result = (await app.procedures["integer-touch"](db, owner, { id: "a", expectedVersion: 2 })).results[0][0];
  assert.equal(result.n, integers[7]); assert.equal(result.version, 3); assert.equal(result.optional, null); checks += 2;
  await native("UPDATE parity_integer SET version=9007199254740993 WHERE id='a'");
  assert.equal((await collection.findById("a")).version, "9007199254740993");
  assert.equal((await app.views["integer-order"](db, owner, {})).find((r: any) => r.id === "a").version, "9007199254740993");
  assert.equal((await collection.update("a", { other: 3 }, { lock: "9007199254740993" })).version, "9007199254740994"); checks++;
  assert.equal(await app.store(db, owner, integerOptions).procedures["integer-ref"]({ id: "a" }), integers[7]);
  assert.equal(await app.store(db, user("integer-b"), integerOptions).procedures["integer-ref"]({ id: "a" }), "absent"); checks += 2;
  assert.equal((await app.store(db, system, integerOptions).collection("parity_child").findById("child")).units, integers[7], "inherited parent integers preserve precision"); checks++;
  await native("UPDATE parity_child SET version=9007199254740991 WHERE id='child'");
  const transition = (await app.procedures["parity_child.unpublish"](db, system, { id: "child", expectedVersion: Number.MAX_SAFE_INTEGER })).results[0][0];
  assert.equal(transition.version, "9007199254740992", "publishing version crosses the safe range without rounding"); checks++;
  return { checks };
}
