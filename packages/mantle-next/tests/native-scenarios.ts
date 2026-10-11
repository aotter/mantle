import assert from "node:assert/strict";
import { pairedReadBenchmark } from "../scripts/bench.js";
import { fixtures, owners } from "./apps/fixtures.js";

export { postgresOracleSql } from "./apps/oracle.js";

/** What a native application writes to return the wire form: ISO timestamps with microseconds and plain dates, formatted by the database. */
export const handwrittenListSql = (sqlite: boolean) => sqlite
  ? "SELECT id, requestnumber, title, amount, approved, sortbucket, requestedunits, strftime('%Y-%m-%dT%H:%M:%S', (submittedat - (submittedat % 1000000 + 1000000) % 1000000) / 1000000, 'unixepoch') || '.' || substr('00000' || ((submittedat % 1000000 + 1000000) % 1000000), -6) || 'Z' AS submittedat, date(neededon * 86400, 'unixepoch') AS neededon, payload FROM purchase_requests WHERE ownerid = ? ORDER BY id"
  : `SELECT id, requestnumber, title, amount, approved, sortbucket, requestedunits, to_char(submittedat AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS submittedat, to_char(neededon, 'YYYY-MM-DD') AS neededon, payload FROM purchase_requests WHERE ownerid = ? ORDER BY id`;

/** Bare queries compare driver-native values, never legacy row coercion. */
export async function verifyBareApplication(
  call: (kind: "view" | "procedure", name: string, owner: string | null, input: Record<string, unknown>) => Promise<unknown>,
  native: (sql: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>,
  sqlite: boolean,
  includeBench = false,
) {
  let checks = 0;
  const owner = owners[0];
  const sql = 'SELECT id, requestnumber, title, amount, approved, sortbucket, requestedunits, submittedat, neededon, payload FROM purchase_requests WHERE ownerid = ? ORDER BY id';
  // The authored fixture, not the generated SQL, is the oracle for the wire form of declared timestamps and dates.
  const wire = (row: Record<string, unknown>) => ({ ...row, submittedat: fixtures[0]!.submittedAt, neededon: fixtures[0]!.neededOn });
  const totals = 'SELECT COUNT(*) AS "requestCount", SUM(amount) AS "totalAmount" FROM purchase_requests WHERE ownerid = ?';
  // Seeded through the generated write: timestamps and dates in wire form on every target, other values driver-ready.
  for (const {ownerId, ...input} of fixtures) await call("procedure", "create-purchase", ownerId, {...input, approved: sqlite ? Number(input.approved) : input.approved, payload: JSON.stringify(input.payload)});
  for (const subject of owners) {
    assert.deepEqual(await call("view", "purchase-list", subject, {}), (await native(sql, [subject])).map(wire), "bare rows equal the native driver's, declared timestamps and dates in wire form"); checks++;
    assert.deepEqual(await call("view", "purchase-totals", subject, {}), await native(totals, [subject]), "bare computed values equal native driver types"); checks++;
    const scalars = sqlite
      ? 'SELECT 1234 AS "fixedAmount", 1791676800123456 AS "microsecondTime", 42 AS "safeInteger" FROM purchase_requests WHERE ownerid = ? ORDER BY id'
      : `SELECT '12.34'::numeric(12,2) AS "fixedAmount", CAST('2026-10-11T00:00:00.123456Z' AS timestamptz) AS "microsecondTime", CAST(42 AS int8) AS "safeInteger" FROM purchase_requests WHERE ownerid = ? ORDER BY id`;
    assert.deepEqual(await call("view", "purchase-scalars", subject, {}), await native(scalars, [subject]), "native scalar representations including PG Date/int8"); checks++;
  }
  await assert.rejects(() => call("view", "purchase-list", null, {})); checks++;
  const {ownerId: _owner, ...fixture} = fixtures[0]!;
  const input = {...fixture, requestNumber:"BARE-NATIVE", approved:sqlite ? 1 : true,
    submittedAt:"2026-10-11T08:00:00.000001+08:00",
    payload:JSON.stringify([1,2,{native:true}]), sortBucket:null};
  const created = await call("procedure", "create-purchase", owner, input) as { results: Record<string, unknown>[][] };
  assert.equal(created.results[0]![0]!.submittedat, "2026-10-11T00:00:00.000001Z", "RETURNING gives the wire form, any input offset normalized to UTC");
  assert.equal(created.results[0]![0]!.neededon, fixture.neededOn); checks++;
  // A timestamp without an offset and a day that does not exist are refused before the write, never rolled over.
  for (const bad of [{submittedAt:"2026-10-11T00:00:00"}, {neededOn:"2026-02-30"}]) {
    await assert.rejects(() => call("procedure", "create-purchase", owner, {...input, ...bad, requestNumber:"BARE-BAD"}), (error: any) => error?.code === "SQL_TYPE");
  }
  assert.deepEqual(await native('SELECT id FROM purchase_requests WHERE requestnumber = ?', ["BARE-BAD"]), []); checks++;
  const [row] = await native('SELECT id, title, amount, version, approved, payload FROM purchase_requests WHERE ownerid = ? AND requestnumber = ?', [owner,input.requestNumber]);
  assert.ok(row); assert.equal(row.approved, sqlite ? 1 : true);
  assert.deepEqual(sqlite ? JSON.parse(String(row.payload)) : row.payload, [1,2,{native:true}]); checks++;
  // Single-statement writes autocommit: a server-reported failure is a known rollback, returned as the native error.
  await assert.rejects(() => call("procedure", "create-purchase", owner, input), (error: any) => sqlite ? error?.code !== "OUTCOME_UNKNOWN" && /UNIQUE/.test(String(error?.message)) : (typeof error?.errno === "string" ? error.errno : error?.code) === "23505"); checks++;
  const update = {id:row.id,expectedVersion:Number(row.version),title:"Bare atomic edit",amount:3.25};
  await assert.rejects(() => call("procedure","update-purchase-double",owner,update));
  assert.deepEqual(await native('SELECT id, title, amount, version, approved, payload FROM purchase_requests WHERE id = ?', [row.id]), [row], "bare OCC failure rolls back earlier statement"); checks++;
  await call("procedure","update-purchase-expected",owner,update);
  const [changed] = await native('SELECT title, amount, version FROM purchase_requests WHERE id = ?', [row.id]);
  assert.equal(changed.title,update.title); assert.equal(Number(changed.amount),3.25); assert.equal(Number(changed.version),Number(row.version)+1); checks++;
  await assert.rejects(() => call("procedure","update-purchase-expected",owner,update)); checks++;
  await assert.rejects(() => call("procedure","update-purchase-expected",owners[1],{...update,expectedVersion:Number(changed.version)}));
  assert.deepEqual(await native('SELECT title, amount, version FROM purchase_requests WHERE id = ?', [row.id]), [changed]); checks++;
  await assert.rejects(() => call("procedure","create-purchase-pair",owner,{...input,requestNumber:"BARE-ROLLBACK"}));
  assert.deepEqual(await native('SELECT id FROM purchase_requests WHERE requestnumber = ?', ["BARE-ROLLBACK"]), []); checks++;
  // No query-level output validator: the SQL commits and returns native results.
  const result = await call("procedure","create-purchase-invalid-output",owner,{...input,requestNumber:"BARE-OUTPUT"});
  assert.ok(result && typeof result === "object" && "results" in result);
  assert.equal((await native('SELECT id FROM purchase_requests WHERE requestnumber = ?', ["BARE-OUTPUT"])).length,1); checks++;
  const benchmark = includeBench ? await pairedReadBenchmark(
    () => call("view","purchase-list",owner,{}),
    async () => { if (!owner) throw new Error("UNAUTHENTICATED"); return native(handwrittenListSql(sqlite),[owner]); },
  ) : undefined;
  return {checks,seededRows:fixtures.length,...(benchmark ? {benchmark} : {})};
}
