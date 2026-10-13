import assert from "node:assert/strict";
const system = {kind: "system", reason: "TTL scheduled cleanup"};
/** Same TTL oracle on actual native hosts and the focused test fixture. */
export async function verifyTtl(app: any, db: any, sqlite: boolean, native: (sql: string, values?: any[]) => Promise<any>, seconds = 0): Promise<void> {
  const operation = app.procedures["session_notes.sweepExpired"];
  assert.equal(app.procedures["catalog_items.sweepExpired"], undefined);
  const clock = 2_000_000_000_000;
  const oldClock = Date.now; Date.now = () => clock;
  try {
    for (const [id, age, owner] of [["old", seconds * 1000 + 1000, "a"], ["edge", seconds * 1000, "b"], ["future", seconds * 1000 - 1, "a"], ["null", null, "b"]] as const) {
      const value = age === null ? null : sqlite ? (clock - age) * 1000 : new Date(clock - age);
      await native(`INSERT INTO session_notes (id,created_at,owner,body,expiresat) VALUES (${sqlite ? "?1,?2,?3,?4,?5" : "$1,$2,$3,$4,$5"})`, [id, sqlite ? clock * 1000 : new Date(clock), owner, id, value]);
    }
    for (const caller of [{kind: "anonymous"}, {kind: "user", subject: "a", role: "owner"}, {kind: "system", reason: ""}]) await assert.rejects(operation(db, caller, {}), {code: "AUTH_DENIED"});
    for (const input of [{limit: 0}, {limit: 501}, {limit: 1.5}, {delete: "false"}, {cursor: "%"}, {cursor: encodeURIComponent(JSON.stringify(["other", 1]))}]) await assert.rejects(operation(db, system, input), {code: "INPUT_VALIDATION_FAILED"});
    const page = await operation(db, system, {limit: 1, delete: false});
    assert.equal(page.scanned, 1); assert.equal(page.removed, 0); assert.equal(typeof page.nextCursor, "string");
    const tail = await operation(db, system, {limit: 1, cursor: page.nextCursor});
    assert.equal(tail.scanned, 1); assert.equal(tail.removed, 1);
    assert.deepEqual(await operation(db, system, {cursor: tail.nextCursor}), {scanned: 0, removed: 0});
    assert.deepEqual(await operation(db, system), {scanned: 1, removed: 1});
    assert.deepEqual(Array.from(await native("SELECT id FROM session_notes WHERE id IN ('old','edge','future','null') ORDER BY id"), (r: any) => r.id), ["future", "null"]);
  } finally {Date.now = oldClock;}
}
