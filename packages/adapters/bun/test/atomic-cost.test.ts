import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan, type AtomicDraftOperation } from "@aotter/mantle-runtime";
import { createBunMantle } from "../src/index.js";

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
metadata: { name: sets }
spec:
  title: Sets
  lifecycle: operational
  schema:
    type: object
    required: [sessionId, reps]
    properties: { sessionId: { type: string }, reps: { type: integer } }
`;

/** Counts statements outside and inside the batch, and can act just before the batch runs. */
function instrument(database: Database) {
  const counts = { reads: 0, batched: 0, batches: 0 };
  let inBatch = false;
  let beforeBatch: (() => void) | null = null;
  const proxy = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "query") return (sql: string) => {
        if (inBatch) counts.batched++; else counts.reads++;
        return target.query(sql);
      };
      if (property === "transaction") return (body: (...args: unknown[]) => unknown) => {
        const run = target.transaction(body);
        return (...args: unknown[]) => {
          const hook = beforeBatch;
          beforeBatch = null;
          hook?.();
          counts.batches++;
          inBatch = true;
          try { return run(...args); } finally { inBatch = false; }
        };
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database: proxy,
    counts,
    reset: () => Object.assign(counts, { reads: 0, batched: 0, batches: 0 }),
    before: (hook: () => void) => { beforeBatch = hook; },
  };
}

async function setup() {
  const parsed = parseManifestSources({ sources: [{ sourceId: "cost", text: source }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const raw = new Database(":memory:");
  const probe = instrument(raw);
  const mantle = createBunMantle({ plan: compiled.value, database: probe.database });
  const runtime = await mantle.getRuntime();
  const session = await runtime.createDraft.execute({ collection: "sessions", data: { name: "s" }, authorId: null });
  const sets = [];
  for (let i = 0; i < 200; i++) {
    sets.push(await runtime.createDraft.execute({ collection: "sets", data: { sessionId: session.id, reps: i + 1 }, authorId: null }));
  }
  return { raw, probe, runtime, session, sets };
}

test("a group reads its targets once per collection and guards each write with two statements", async () => {
  const { raw, probe, runtime, session, sets } = await setup();
  const operations: AtomicDraftOperation[] = [
    { kind: "update", request: { collection: "sessions", id: session.id, expectedVersion: 1, data: { name: "renamed" } } },
    ...sets.slice(0, 150).map((set): AtomicDraftOperation => ({ kind: "update",
      request: { collection: "sets", id: set.id, expectedVersion: 1, data: { reps: 99 } } })),
    ...sets.slice(150).map((set): AtomicDraftOperation => ({ kind: "delete",
      request: { collection: "sets", id: set.id, expectedVersion: 1 } })),
    { kind: "create", request: { collection: "sets", data: { sessionId: session.id, reps: 1 }, authorId: null } },
  ];
  probe.reset();
  await runtime.writeAtomically.execute(operations);
  // One read for the session, ceil(200 / 95) = 3 for the sets: not one per operation.
  expect(probe.counts.reads).toBe(4);
  // 201 guarded writes x (mutation + guard) + 1 create + 1 cleanup.
  expect(probe.counts.batched).toBe(201 * 2 + 1 + 1);
  expect(probe.counts.batches).toBe(1);
  expect(raw.query("SELECT count(*) AS n FROM sets").get()).toEqual({ n: 151 });
  expect(raw.query("SELECT count(*) AS n FROM _mantle_boot_state WHERE id = 'atomic-guard'").get()).toEqual({ n: 0 });
  raw.close();
});

test("the shared guard still rejects a write that went stale after the prefetch, wherever it sits", async () => {
  const { raw, probe, runtime, session, sets } = await setup();
  const target = sets[100]!;
  const operations: AtomicDraftOperation[] = [
    ...sets.slice(0, 200).map((set): AtomicDraftOperation => ({ kind: "update",
      request: { collection: "sets", id: set.id, expectedVersion: 1, data: { reps: 777 } } })),
    { kind: "update", request: { collection: "sessions", id: session.id, expectedVersion: 1, data: { name: "renamed" } } },
  ];
  // A concurrent writer lands between the group's read and its batch.
  probe.before(() => raw.run(`UPDATE sets SET "_mantle_version" = 2 WHERE "_mantle_id" = ?`, [target.id]));
  await expect(runtime.writeAtomically.execute(operations))
    .rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(raw.query("SELECT count(*) AS n FROM sets WHERE reps = 777").get()).toEqual({ n: 0 });
  expect(raw.query(`SELECT name FROM sessions WHERE "_mantle_id" = ?`).get(session.id)).toEqual({ name: "s" });
  expect(raw.query("SELECT count(*) AS n FROM _mantle_boot_state WHERE id = 'atomic-guard'").get()).toEqual({ n: 0 });

  // A target deleted before the group reads it is still NOT_FOUND, as with a single-entry update.
  raw.run(`DELETE FROM sets WHERE "_mantle_id" = ?`, [sets[5]!.id]);
  await expect(runtime.writeAtomically.execute([
    { kind: "update", request: { collection: "sets", id: sets[5]!.id, expectedVersion: 1, data: { reps: 1 } } },
  ])).rejects.toMatchObject({ diagnostic: { code: "NOT_FOUND" } });
  raw.close();
});
