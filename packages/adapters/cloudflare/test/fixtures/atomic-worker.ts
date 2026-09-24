import { DiagnosticError, linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { bootMantleRuntime, compileRuntimePlan, SqliteMantleStorageAdapter } from "@aotter/mantle-runtime";
import { D1DatabaseDriver } from "../../src/bindings/D1DatabaseDriver.js";

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
    const committed = await runtime.writeAtomically.execute([
      { kind: "create", request: { collection: "sessions", data: { name: token }, authorId: null } },
      { kind: "create", request: { collection: "receipts", data: { token }, authorId: null } },
    ]);
    let duplicate = false;
    try {
      await runtime.writeAtomically.execute([
        { kind: "create", request: { collection: "sessions", data: { name: `duplicate-${token}` }, authorId: null } },
        { kind: "create", request: { collection: "receipts", data: { token }, authorId: null } },
      ]);
    } catch (error) { duplicate = conflict(error); }
    let duplicateBatch = false;
    try {
      await runtime.writeAtomically.execute([
        { kind: "create", request: { collection: "sessions", data: { name: `batch-${token}` }, authorId: null } },
        { kind: "create", request: { collection: "receipts", data: { token: `batch-${token}` }, authorId: null } },
        { kind: "create", request: { collection: "receipts", data: { token: `batch-${token}` }, authorId: null } },
      ]);
    } catch (error) { duplicateBatch = conflict(error); }
    await runtime.writeAtomically.execute([
      { kind: "delete", request: { collection: "receipts", id: committed[1]!.id, expectedVersion: 1 } },
      { kind: "create", request: { collection: "receipts", data: { token }, authorId: null } },
    ]);
    const existing = committed[0]!;
    await runtime.updateDraft.execute({ collection: "sessions", id: existing.id, expectedVersion: 1, data: { name: `updated-${token}` } });
    let statusMismatch = false;
    try {
      await runtime.writeAtomically.execute([
        { kind: "create", request: { collection: "receipts", data: { token: `status-mismatch-${token}` }, authorId: null } },
        { kind: "delete", request: { collection: "sessions", id: existing.id, expectedVersion: 2, expectedStatus: "draft" } },
      ]);
    } catch (error) { statusMismatch = conflict(error); }
    let stale = false;
    try {
      await runtime.writeAtomically.execute([
        { kind: "create", request: { collection: "receipts", data: { token: `stale-${token}` }, authorId: null } },
        { kind: "update", request: { collection: "sessions", id: existing.id, expectedVersion: 1, data: { name: "stale" } } },
      ]);
    } catch (error) { stale = conflict(error); }
    let staleDelete = false;
    try {
      await runtime.writeAtomically.execute([
        { kind: "create", request: { collection: "receipts", data: { token: `stale-delete-${token}` }, authorId: null } },
        { kind: "delete", request: { collection: "sessions", id: existing.id, expectedVersion: 1 } },
      ]);
    } catch (error) { staleDelete = conflict(error); }
    let invalid = false;
    try {
      await runtime.writeAtomically.execute([
        { kind: "create", request: { collection: "sessions", data: { name: `invalid-${token}` }, authorId: null } },
        { kind: "create", request: { collection: "receipts", data: { token: 17 }, authorId: null } },
      ]);
    } catch (error) { invalid = error instanceof DiagnosticError && error.diagnostic.code === "INPUT_VALIDATION_FAILED"; }
    await runtime.writeAtomically.execute([
      { kind: "delete", request: { collection: "sessions", id: existing.id, expectedVersion: 2 } },
      { kind: "create", request: { collection: "receipts", data: { token: `done-${token}` }, authorId: null } },
    ]);
    const sessions = await runtime.listEntries.execute({ collection: "sessions" });
    const receipts = await runtime.listEntries.execute({ collection: "receipts" });
    const passed = duplicate && duplicateBatch && statusMismatch && stale && staleDelete && invalid &&
      sessions.filter((row) => row.data.name === token || row.data.name === `updated-${token}`).length === 0 &&
      !sessions.some((row) => row.data.name === `duplicate-${token}` || row.data.name === `batch-${token}` || row.data.name === `invalid-${token}`) &&
      receipts.filter((row) => row.data.token === token).length === 1 &&
      receipts.filter((row) => row.data.token === `done-${token}`).length === 1 &&
      !receipts.some((row) => row.data.token === `batch-${token}` || row.data.token === `status-mismatch-${token}` || row.data.token === `stale-${token}` || row.data.token === `stale-delete-${token}`);
    return Response.json({ passed, duplicate, duplicateBatch, statusMismatch, stale, staleDelete, invalid }, { status: passed ? 200 : 500 });
  },
};

function conflict(error: unknown): boolean {
  return error instanceof DiagnosticError && error.diagnostic.code === "CONFLICT";
}
