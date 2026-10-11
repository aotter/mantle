import assert from "node:assert/strict";
import * as z from "zod/mini";
import { ContractError, decodeField } from "../src/kernel/contracts.js";
import { validate } from "../src/kernel/checked.js";
const nativeReadInput = z.strictObject({});
import { pairedReadBenchmark } from "../scripts/bench.js";
import { expectedPurchases, expectedTotals, fixtures, owners } from "./apps/fixtures.js";

export const purchaseSql = 'SELECT id, requestnumber AS "requestNumber", title, amount, approved, sortbucket AS "sortBucket", requestedunits AS "requestedUnits", submittedat AS "submittedAt", neededon AS "neededOn", payload FROM purchase_requests WHERE ownerid = ? ORDER BY id';
export function decodePgPurchase(result: { rows: Record<string, string | null>[]; fields: { dataTypeID: number; dataTypeModifier: number }[] }) {
  return result.rows.map(row => ({
    id: decodeField(result.fields[0]!.dataTypeID, row.id!, result.fields[0]!.dataTypeModifier),
    requestNumber: decodeField(result.fields[1]!.dataTypeID, row.requestNumber!, result.fields[1]!.dataTypeModifier),
    title: decodeField(result.fields[2]!.dataTypeID, row.title!, result.fields[2]!.dataTypeModifier),
    amount: decodeField(result.fields[3]!.dataTypeID, row.amount!, result.fields[3]!.dataTypeModifier),
    approved: decodeField(result.fields[4]!.dataTypeID, row.approved!, result.fields[4]!.dataTypeModifier),
    sortBucket: decodeField(result.fields[5]!.dataTypeID, row.sortBucket!, result.fields[5]!.dataTypeModifier),
    requestedUnits: decodeField(result.fields[6]!.dataTypeID, row.requestedUnits!, result.fields[6]!.dataTypeModifier),
    submittedAt: decodeField(result.fields[7]!.dataTypeID, row.submittedAt!, result.fields[7]!.dataTypeModifier),
    neededOn: decodeField(result.fields[8]!.dataTypeID, row.neededOn!, result.fields[8]!.dataTypeModifier),
    payload: decodeField(result.fields[9]!.dataTypeID, row.payload!, result.fields[9]!.dataTypeModifier),
  }));
}

export function postgresOracleSql(sql: string) {
  let parameter = 0;
  return sql.replace(/\?/g, () => `$${++parameter}`);
}
function nativeProjection(row: Record<string, unknown>): Record<string, unknown> {
  const timestamp = row.submittedAt;
  const day = row.neededOn;
  return { ...row, amount: Number(row.amount), approved: row.approved === true || row.approved === 1 || row.approved === "t", requestedUnits: Number(row.requestedUnits),
    submittedAt: timestamp instanceof Date ? timestamp.toISOString() : typeof timestamp === "number" ? new Date(Math.floor(timestamp / 1000)).toISOString().replace('Z', String(timestamp % 1000).padStart(3, '0') + 'Z') : typeof timestamp === "string" ? timestamp.replace(" ", "T").replace(/\+00(?::00)?$/, "Z") : timestamp,
    neededOn: day instanceof Date ? day.toISOString().slice(0, 10) : typeof day === "number" ? new Date(day * 86400000).toISOString().slice(0, 10) : day,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload };
}

/** Calls below must be backed by actual generated functions and actual native drivers. */
export async function verifyNativeApplication(
  call: (kind: "view" | "procedure", name: string, owner: string | null, input: Record<string, unknown>) => Promise<unknown>,
  native: (sql: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>,
  includeBench = false,
  sqlite = false,
  matchedRead?: (owner: string) => Promise<unknown>,
) {
  let checks = 0;
  for (const { ownerId, ...input } of fixtures) await call("procedure", "create-purchase", ownerId, input);
  for (const owner of owners) {
    const actual = await call("view", "purchase-list", owner, {}) as Record<string, unknown>[];
    const raw = await native(purchaseSql, [owner]);
    const expected = raw.map(nativeProjection);
    assert.deepEqual(actual, expected, "generated projection equals handwritten native query");
    assert.deepEqual(actual.map(({ id: _id, ...row }) => row).sort((a, b) => String(a.requestNumber).localeCompare(String(b.requestNumber))), expectedPurchases(owner), "independent authored fixture oracle");
    const totals = await call("view", "purchase-totals", owner, {}) as Record<string, unknown>[];
    assert.deepEqual(totals, [expectedTotals(owner)], "aggregate and owner isolation");
    const shared = await call("view", "purchase-shared-list", owner, {});
    assert.deepEqual(shared, expected.map(({ id, title, amount }) => ({ id, title, amount })), "shared view projection and order");
    checks += 4;
  }
  await assert.rejects(() => call("view", "purchase-list", null, {})); checks++;
  const owner = owners[0];
  const [before] = await native('SELECT id, title, amount, version FROM purchase_requests WHERE ownerid = ? AND requestnumber = ?', [owner, "REQ-0-0000"]);
  assert.ok(before);
  const update = { id: before.id, expectedVersion: Number(before.version), title: "Atomic edit", amount: 12.5 };
  await assert.rejects(() => call("procedure", "update-purchase-double", owner, update));
  assert.deepEqual(await native('SELECT id, title, amount, version FROM purchase_requests WHERE id = ?', [before.id]), [before], "second stale write rolls back first write before commit"); checks++;
  await call("procedure", "update-purchase-expected", owner, update);
  const [after] = await native('SELECT id, title, amount, version FROM purchase_requests WHERE id = ?', [before.id]);
  assert.equal(after.title, update.title); assert.equal(Number(after.amount), update.amount); assert.equal(Number(after.version), Number(before.version) + 1); checks++;
  await assert.rejects(() => call("procedure", "update-purchase-expected", owner, update));
  assert.deepEqual(await native('SELECT id, title, amount, version FROM purchase_requests WHERE id = ?', [before.id]), [after], "stale OCC leaves physical row unchanged"); checks++;
  await assert.rejects(() => call("procedure", "update-purchase-expected", owners[1], { ...update, expectedVersion: Number(after.version) }));
  assert.deepEqual(await native('SELECT id, title, amount, version FROM purchase_requests WHERE id = ?', [before.id]), [after], "foreign caller cannot update scoped row"); checks++;
  const { ownerId: _owner, ...baseInput } = fixtures[0]!;
  await assert.rejects(() => call("procedure", "create-purchase-pair", owner, { ...baseInput, requestNumber: "ROLLBACK-PAIR", title: "Rollback", amount: 1, approved: false, sortBucket: null }));
  assert.deepEqual(await native('SELECT id FROM purchase_requests WHERE requestnumber = ?', ["ROLLBACK-PAIR"]), [], "native uniqueness failure rolls back first insertion"); checks++;
  await assert.rejects(() => call("procedure", "create-purchase", owner, { ...baseInput, requestNumber: "INVALID", title: "Invalid", amount: -1, approved: false, sortBucket: null }));
  assert.deepEqual(await native('SELECT id FROM purchase_requests WHERE requestnumber = ?', ["INVALID"]), [], "validation fails before native write"); checks++;
  for (const owner of owners) {
    assert.deepEqual(await call("view", "purchase-scalars", owner, {}), Array.from({ length: 120 }, () => (sqlite ? { fixedAmount: 1234, microsecondTime: 1791676800123456, safeInteger: 42 } : { fixedAmount: "12.34", microsecondTime: "2026-10-11T00:00:00.123456Z", safeInteger: 42 })), "computed SQL scalar types preserve numeric scale/int8/microseconds"); checks++;
  }
  for (const owner of owners) {
    const actual = await call("view", "purchase-calendar", owner, {});
    const sql = sqlite
      ? 'SELECT CAST(submittedat / 86400000000 AS INTEGER) * 86400000000 AS "submittedDay" FROM purchase_requests WHERE ownerid = ? ORDER BY id'
      : `SELECT date_trunc('day', submittedat AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "submittedDay" FROM purchase_requests WHERE ownerid = ? ORDER BY id`;
    const raw = await native(sql, [owner]);
    const expected = raw.map(row => ({ submittedDay: sqlite ? Number(row.submittedDay) : String(row.submittedDay).replace(" ", "T").replace(/(?:\.(\d+))?\+00(?::00)?$/, (_match, fraction: string | undefined) => "." + (fraction ?? "").padEnd(6, "0") + "Z") }));
    assert.deepEqual(actual, expected, "calendar View equals independent native UTC day calculation");
    assert.deepEqual(actual, Array.from({ length: 120 }, () => ({ submittedDay: sqlite ? 1791676800000000 : "2026-10-11T00:00:00.000000Z" })), "UTC midnight and canonical timezone DDL"); checks++;
  }
  await assert.rejects(() => call("procedure", "create-purchase-invalid-output", owner, { ...baseInput, requestNumber: "COMMITTED-OUTPUT-FAILURE" }), (error: unknown) => {
    assert.ok(error && typeof error === "object" && "path" in error && typeof error.path === "string");
    assert.ok("code" in error);
    assert.equal(error.code, "OUTPUT_VALIDATION_FAILED");
    assert.ok(error.path.startsWith("procedures/create-purchase-invalid-output/output"), "rejection belongs to output validation after SQL execution");
    return true;
  }); checks++;
  const committed = await native('SELECT requestnumber AS "requestNumber", title FROM purchase_requests WHERE ownerid = ? AND requestnumber = ?', [owner, "COMMITTED-OUTPUT-FAILURE"]);
  assert.deepEqual(committed, [{ requestNumber: "COMMITTED-OUTPUT-FAILURE", title: baseInput.title }], "output validation failure leaves successful SQL committed, matching 0.2"); checks++;
  const benchmark = includeBench ? await pairedReadBenchmark(
    () => call("view", "purchase-list", owner, {}),
    async () => {
      const caller = { kind: "user", subject: owner, role: null, scopes: [], credential: "session", credentialId: null, clientId: null };
      if (caller.kind !== "user") throw new ContractError("UNAUTHENTICATED", "Authorization predicate not satisfied.");
      validate(nativeReadInput, {}, "views/purchase-list/input");
      return matchedRead ? matchedRead(caller.subject) : (await native(purchaseSql, [caller.subject])).map(nativeProjection);
    },
  ) : undefined;
  return { checks, seededRows: fixtures.length, ...(benchmark ? { benchmark } : {}) };
}


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
  const totals = 'SELECT COUNT(*) AS "requestCount", SUM(amount) AS "totalAmount" FROM purchase_requests WHERE ownerid = ?';
  for (const subject of owners) {
    assert.deepEqual(await call("view", "purchase-list", subject, {}), await native(sql, [subject]), "bare rows equal default driver without codecs or aliases"); checks++;
    assert.deepEqual(await call("view", "purchase-totals", subject, {}), await native(totals, [subject]), "bare computed values equal native driver types"); checks++;
    const scalars = sqlite
      ? 'SELECT 1234 AS "fixedAmount", 1791676800123456 AS "microsecondTime", 42 AS "safeInteger" FROM purchase_requests WHERE ownerid = ? ORDER BY id'
      : `SELECT '12.34'::numeric(12,2) AS "fixedAmount", CAST('2026-10-11T00:00:00.123456Z' AS timestamptz) AS "microsecondTime", CAST(42 AS int8) AS "safeInteger" FROM purchase_requests WHERE ownerid = ? ORDER BY id`;
    assert.deepEqual(await call("view", "purchase-scalars", subject, {}), await native(scalars, [subject]), "native scalar representations including PG Date/int8"); checks++;
  }
  await assert.rejects(() => call("view", "purchase-list", null, {})); checks++;
  const {ownerId: _owner, ...fixture} = fixtures[0]!;
  const input = {...fixture, requestNumber:"BARE-NATIVE", approved:sqlite ? 1 : true,
    submittedAt:sqlite ? 1791676800123456 : fixture.submittedAt,
    neededOn:sqlite ? Date.parse(fixture.neededOn) / 86400000 : fixture.neededOn,
    payload:JSON.stringify([1,2,{native:true}]), sortBucket:null};
  await call("procedure", "create-purchase", owner, input);
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
    async () => { if (!owner) throw new Error("UNAUTHENTICATED"); return native(sql,[owner]); },
  ) : undefined;
  return {checks,...(benchmark ? {benchmark} : {})};
}
