import { DiagnosticError, linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { bootMantleRuntime, compileRuntimePlan, SqliteMantleStorageAdapter, type MantleStore } from "@aotter/mantle-runtime";
import { D1DatabaseDriver } from "../../src/bindings/D1DatabaseDriver.js";

type StoreWriteResult = Awaited<ReturnType<MantleStore["write"]>>[number];

const source = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: sessions }
spec:
  title: Sessions
  lifecycle: operational
  schema:
    type: object
    required: [name]
    properties: { name: { type: string } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: receipts }
spec:
  title: Receipts
  lifecycle: operational
  uniqueIndexes: [[token]]
  schema:
    type: object
    required: [token]
    properties: { token: { type: string } }
`;

const parsed = parseManifestSources({ sources: [{ sourceId: "atomic-d1", text: source }] });
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const linked = linkManifestSet(parsed.value);
if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
const compiled = compileRuntimePlan(linked.value);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));

export default {
  async fetch(_request: Request, env: { DB: D1Database }): Promise<Response> {
    const runtime = await bootMantleRuntime({
      plan: compiled.value,
      storage: new SqliteMantleStorageAdapter(new D1DatabaseDriver(env.DB)),
    });
    const token = crypto.randomUUID();
    const committed = await runtime.store.write([
      { insert: "sessions", values: { name: token } },
      { insert: "receipts", values: { token } },
    ]);
    let duplicate = false;
    try {
      await runtime.store.write([
        { insert: "sessions", values: { name: `duplicate-${token}` } },
        { insert: "receipts", values: { token } },
      ]);
    } catch (error) { duplicate = conflict(error); }
    let duplicateBatch = false;
    try {
      await runtime.store.write([
        { insert: "sessions", values: { name: `batch-${token}` } },
        { insert: "receipts", values: { token: `batch-${token}` } },
        { insert: "receipts", values: { token: `batch-${token}` } },
      ]);
    } catch (error) { duplicateBatch = conflict(error); }
    await runtime.store.write([
      { delete: "receipts", where: { id: idOf(committed[1]) }, lock: 1 },
      { insert: "receipts", values: { token } },
    ]);
    const existing = idOf(committed[0]);
    await runtime.updateDraft.execute({ collection: "sessions", id: existing, expectedVersion: 1, data: { name: `updated-${token}` } });
    // A set-based delete whose expected count is not met rolls back the group.
    let countMismatch = false;
    try {
      await runtime.store.write([
        { insert: "receipts", values: { token: `count-mismatch-${token}` } },
        { delete: "sessions", where: { name: `absent-${token}` }, expect: 1 },
      ]);
    } catch (error) { countMismatch = conflict(error); }
    let stale = false;
    try {
      await runtime.store.write([
        { insert: "receipts", values: { token: `stale-${token}` } },
        { update: "sessions", set: { name: "stale" }, where: { id: existing }, lock: 1 },
      ]);
    } catch (error) { stale = conflict(error); }
    let staleDelete = false;
    try {
      await runtime.store.write([
        { insert: "receipts", values: { token: `stale-delete-${token}` } },
        { delete: "sessions", where: { id: existing }, lock: 1 },
      ]);
    } catch (error) { staleDelete = conflict(error); }
    // Several guarded writes share one guard row and one cleanup: a stale
    // write in the middle still rolls back the others, and a clean group commits.
    const trio = (await runtime.store.write(["a", "b", "c"].map((part) => (
      { insert: "sessions", values: { name: `trio-${part}-${token}` } })))).map(idOf);
    let staleMiddle = false;
    try {
      await runtime.store.write(trio.map((id, index) => ({
        update: "sessions", set: { name: `moved-${index}-${token}` }, where: { id }, lock: index === 1 ? 7 : 1,
      })));
    } catch (error) { staleMiddle = conflict(error); }
    const untouched = (await runtime.listEntries.execute({ collection: "sessions" }))
      .filter((row) => row.data.name === `moved-0-${token}` || row.data.name === `moved-2-${token}`).length === 0;
    await runtime.store.write(trio.map((id) => ({ delete: "sessions", where: { id }, lock: 1 })));
    const multiGuard = staleMiddle && untouched &&
      !(await runtime.listEntries.execute({ collection: "sessions" })).some((row) => String(row.data.name).startsWith("trio-"));
    // Set-based deletes commit together, a subquery included, and report their counts.
    const pairNames = [`set-a-${token}`, `set-b-${token}`];
    const pair = (await runtime.store.write([
      ...pairNames.map((name) => ({ insert: "sessions", values: { name } })),
      ...pairNames.map((name) => ({ insert: "receipts", values: { token: name } })),
    ])).slice(0, 2).map(idOf);
    const setBased = await runtime.store.write([
      { delete: "receipts", where: { token: { in: { select: "name", from: "sessions", where: { id: { in: pair } } } } }, expect: 2 },
      { delete: "sessions", where: { id: { in: pair } }, expect: 2 },
      { delete: "sessions", where: { name: `absent-${token}` } },
    ]);
    const setDelete = JSON.stringify(setBased) === JSON.stringify([{ deleted: 2 }, { deleted: 2 }, { deleted: 0 }]);
    let invalid = false;
    try {
      await runtime.store.write([
        { insert: "sessions", values: { name: `invalid-${token}` } },
        { insert: "receipts", values: { token: 17 } },
      ]);
    } catch (error) { invalid = error instanceof DiagnosticError && error.diagnostic.code === "INPUT_VALIDATION_FAILED"; }
    await runtime.store.write([
      { delete: "sessions", where: { id: existing }, lock: 2 },
      { insert: "receipts", values: { token: `done-${token}` } },
    ]);
    const sessions = await runtime.listEntries.execute({ collection: "sessions" });
    const receipts = await runtime.listEntries.execute({ collection: "receipts" });
    const passed = duplicate && duplicateBatch && countMismatch && stale && staleDelete && invalid && multiGuard && setDelete &&
      sessions.filter((row) => row.data.name === token || row.data.name === `updated-${token}`).length === 0 &&
      !sessions.some((row) => row.data.name === `duplicate-${token}` || row.data.name === `batch-${token}` || row.data.name === `invalid-${token}`) &&
      receipts.filter((row) => row.data.token === token).length === 1 &&
      receipts.filter((row) => row.data.token === `done-${token}`).length === 1 &&
      !receipts.some((row) => row.data.token === `batch-${token}` || row.data.token === `count-mismatch-${token}` || row.data.token === `stale-${token}` || row.data.token === `stale-delete-${token}`);
    return Response.json({ passed, duplicate, duplicateBatch, countMismatch, stale, staleDelete, invalid, multiGuard, setDelete }, { status: passed ? 200 : 500 });
  },
};

function idOf(result: StoreWriteResult | undefined): string {
  if (!result || !("id" in result)) throw new Error("expected an inserted or updated row");
  return result.id;
}

function conflict(error: unknown): boolean {
  return error instanceof DiagnosticError && error.diagnostic.code === "CONFLICT";
}
