import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan, type MantleStore } from "@aotter/mantle-runtime";
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
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: passes }
spec:
  title: Passes
  lifecycle: operational
  ttl: { field: expiresAt, expireAfterSeconds: 0 }
  schema:
    type: object
    required: [expiresAt]
    properties: { expiresAt: { type: string, format: date-time } }
`;

type StoreWriteOp = Parameters<MantleStore["write"]>[0][number];

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
  const operations: StoreWriteOp[] = [
    { update: "sessions", set: { name: "renamed" }, where: { id: session.id }, lock: 1 },
    ...sets.slice(0, 150).map((set): StoreWriteOp => ({ update: "sets", set: { reps: 99 }, where: { id: set.id }, lock: 1 })),
    ...sets.slice(150).map((set): StoreWriteOp => ({ delete: "sets", where: { id: set.id }, lock: 1 })),
    { insert: "sets", values: { sessionId: session.id, reps: 1 } },
  ];
  probe.reset();
  await runtime.store.write(operations);
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
  const operations: StoreWriteOp[] = [
    ...sets.slice(0, 200).map((set): StoreWriteOp => ({ update: "sets", set: { reps: 777 }, where: { id: set.id }, lock: 1 })),
    { update: "sessions", set: { name: "renamed" }, where: { id: session.id }, lock: 1 },
  ];
  // A concurrent writer lands between the group's read and its batch.
  probe.before(() => raw.run(`UPDATE sets SET "_mantle_version" = 2 WHERE "_mantle_id" = ?`, [target.id]));
  await expect(runtime.store.write(operations))
    .rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(raw.query("SELECT count(*) AS n FROM sets WHERE reps = 777").get()).toEqual({ n: 0 });
  expect(raw.query(`SELECT name FROM sessions WHERE "_mantle_id" = ?`).get(session.id)).toEqual({ name: "s" });
  expect(raw.query("SELECT count(*) AS n FROM _mantle_boot_state WHERE id = 'atomic-guard'").get()).toEqual({ n: 0 });

  // A target deleted before the group reads it is still NOT_FOUND, as with a single-entry update.
  raw.run(`DELETE FROM sets WHERE "_mantle_id" = ?`, [sets[5]!.id]);
  await expect(runtime.store.write([
    { update: "sets", set: { reps: 1 }, where: { id: sets[5]!.id }, lock: 1 },
  ])).rejects.toMatchObject({ diagnostic: { code: "NOT_FOUND" } });
  raw.close();
});

test("a stale write is caught first, last, as a delete or by status, and the conflict names it", async () => {
  const { raw, probe, runtime, sets } = await setup();
  const group = (stale: number, kind: "update" | "delete"): StoreWriteOp[] => sets.slice(0, 10).map((set, index) =>
    kind === "update" || index !== stale
      ? { update: "sets", set: { reps: 555 }, where: { id: set.id }, lock: 1 }
      : { delete: "sets", where: { id: set.id }, lock: 1 });
  for (const [stale, kind] of [[0, "update"], [9, "update"], [4, "delete"]] as const) {
    probe.before(() => raw.run(`UPDATE sets SET "_mantle_version" = 2 WHERE "_mantle_id" = ?`, [sets[stale]!.id]));
    const failure = await runtime.store.write(group(stale, kind)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ diagnostic: { code: "CONFLICT" } });
    expect(JSON.stringify((failure as { diagnostic: unknown }).diagnostic)).toContain(sets[stale]!.id);
    expect(raw.query("SELECT count(*) AS n FROM sets WHERE reps = 555").get()).toEqual({ n: 0 });
    expect(raw.query("SELECT count(*) AS n FROM sets").get()).toEqual({ n: 200 });
    raw.run(`UPDATE sets SET "_mantle_version" = 1 WHERE "_mantle_id" = ?`, [sets[stale]!.id]);
  }
  // A status that moved between read and batch, under the shared guard.
  probe.before(() => raw.run(`UPDATE sets SET "_mantle_status" = 'archived' WHERE "_mantle_id" = ?`, [sets[3]!.id]));
  await expect(runtime.store.write(group(-1, "update")))
    .rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(raw.query("SELECT count(*) AS n FROM sets WHERE reps = 555").get()).toEqual({ n: 0 });
  raw.close();
});

test("a leftover guard row neither hides a stale write nor blocks a clean group", async () => {
  const { raw, probe, runtime, sets } = await setup();
  raw.run("INSERT INTO _mantle_boot_state (id, fingerprint) VALUES ('atomic-guard', 'ok')");
  probe.before(() => raw.run(`UPDATE sets SET "_mantle_version" = 2 WHERE "_mantle_id" = ?`, [sets[1]!.id]));
  await expect(runtime.store.write(sets.slice(0, 3).map((set): StoreWriteOp => ({
    update: "sets", set: { reps: 555 }, where: { id: set.id }, lock: 1 }))))
    .rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(raw.query("SELECT count(*) AS n FROM sets WHERE reps = 555").get()).toEqual({ n: 0 });
  await runtime.store.write([
    { update: "sets", set: { reps: 555 }, where: { id: sets[5]!.id }, lock: 1 },
  ]);
  expect(raw.query("SELECT count(*) AS n FROM sets WHERE reps = 555").get()).toEqual({ n: 1 });
  expect(raw.query("SELECT count(*) AS n FROM _mantle_boot_state WHERE id = 'atomic-guard'").get()).toEqual({ n: 0 });
  raw.close();
});

test("the prefetch hides expired rows across a chunk boundary, and a group still touches each entry once", async () => {
  const { raw, probe, runtime, sets } = await setup();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const passes = [];
  for (let i = 0; i < 97; i++) {
    passes.push(await runtime.createDraft.execute({ collection: "passes", data: { expiresAt: future }, authorId: null }));
  }
  // The 96th id opens the second 95-id chunk; it expires before the group reads it.
  raw.run(`UPDATE passes SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE "_mantle_id" = ?`, [passes[95]!.id]);
  probe.reset();
  await expect(runtime.store.write(passes.map((pass): StoreWriteOp => ({
    delete: "passes", where: { id: pass.id }, lock: 1 }))))
    .rejects.toMatchObject({ diagnostic: { code: "NOT_FOUND" } });
  expect(probe.counts.reads).toBe(2);
  expect(probe.counts.batches).toBe(0);
  await expect(runtime.store.write([
    { update: "sets", set: { reps: 1 }, where: { id: sets[0]!.id }, lock: 1 },
    { delete: "sets", where: { id: sets[0]!.id }, lock: 1 },
  ])).rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
  raw.close();
});

test("errors keep operation order when a later operation names an unknown Schema", async () => {
  const { raw, runtime } = await setup();
  await expect(runtime.store.write([
    { update: "sets", set: { reps: 1 }, where: { id: "missing" }, lock: 1 },
    { update: "nope", set: {}, where: { id: "x" }, lock: 1 },
  ])).rejects.toMatchObject({ diagnostic: { code: "NOT_FOUND" } });
  await expect(runtime.store.write([
    { upsert: "nope", where: { id: "x" } } as unknown as StoreWriteOp,
  ])).rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
  raw.close();
});

test("a set-based delete is one statement, plus a guard and its cleanup only with expect", async () => {
  const { raw, probe, runtime, session } = await setup();
  probe.reset();
  expect(await runtime.store.write([{ delete: "sets", where: { reps: { lte: 50 } } }])).toEqual([{ deleted: 50 }]);
  expect(probe.counts).toEqual({ reads: 0, batched: 1, batches: 1 });
  probe.reset();
  expect(await runtime.store.write([{ delete: "sets", where: { sessionId: session.id, reps: { lte: 100 } }, expect: 50 }]))
    .toEqual([{ deleted: 50 }]);
  expect(probe.counts).toEqual({ reads: 0, batched: 3, batches: 1 });
  await expect(runtime.store.write([{ delete: "sets", where: { reps: { lte: 150 } }, expect: 1 }]))
    .rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  expect(raw.query("SELECT count(*) AS n FROM sets").get()).toEqual({ n: 100 });
  expect(raw.query("SELECT count(*) AS n FROM _mantle_boot_state WHERE id = 'atomic-guard'").get()).toEqual({ n: 0 });
  raw.close();
});
