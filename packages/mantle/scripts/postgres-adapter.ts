/** Reusable application-owned adapter check. The factory must open an isolated, disposable database/schema. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { unstable_splitSqlQuery } from "wrangler";
import type { Postgres } from "../src/kernel/contracts.js";
import { procedure, transaction } from "../src/kernel/driver/postgres.js";
import { generateOrThrow, writeGenerated } from "../tests/apps/link.js";

export type PostgresAdapterFactory = () => Promise<{ db: Postgres; close(): Promise<void>; interactive?: boolean }>;

const atom = (kind: string, name: string, spec: object) => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind, metadata: { name }, spec });
const properties = { key: { type: "string" }, at: { type: "string", format: "date-time" }, day: { type: "string", format: "date" }, payload: { type: "object" }, units: { type: "integer" }, enabled: { type: "boolean" }, amount: { type: "number" } };
const source = [
  atom("Schema", "adapter_items", { title: "Adapter conformance", schema: { type: "object", properties, required: Object.keys(properties) }, uniqueIndexes: [["key"]] }),
  atom("View", "adapter-items", { surface: "internal", sql: "SELECT id, key, at, day, payload, units, enabled, amount, created_at, CAST(at AS timestamptz) AS computed_at FROM adapter_items ORDER BY id" }),
  atom("Procedure", "adapter-create", { input: { type: "object", properties, required: Object.keys(properties) }, output: { type: "object" }, handler: { sql: "INSERT INTO adapter_items(key, at, day, payload, units, enabled, amount) VALUES(input.key, input.at, input.day, input.payload, input.units, input.enabled, input.amount) RETURNING id, at, day, payload, units, enabled, amount" } }),
].join("\n---\n");

/** Returns only a check count; assertions retain the exact failing contract. No latency or benchmark data. */
export async function verifyPostgresAdapter(factory: PostgresAdapterFactory): Promise<{ checks: number }> {
  const files = await generateOrThrow("bun-postgres", [{ sourceId: "adapter-conformance.yaml", text: source }]);
  await mkdir(resolve(import.meta.dir, "../tests/apps/.generated"), { recursive: true });
  const directory = await mkdtemp(resolve(import.meta.dir, "../tests/apps/.generated/adapter-"));
  let client: Awaited<ReturnType<PostgresAdapterFactory>> | undefined;
  let checks = 0;
  try {
    await writeGenerated(directory, files);
    const app = await import(pathToFileURL(resolve(directory, "generated.ts")).href);
    client = await factory();
    const { db, interactive = true } = client;
    for (const sql of unstable_splitSqlQuery(files["schema.sql"]!)) await db.unsafe(sql, []);
    const caller = { kind: "system", reason: "adapter conformance" } as const;
    const input = { key: "first", at: "2026-10-12T08:00:00.123456+08:00", day: "2024-02-29", payload: JSON.stringify({ text: "'\\", nested: [false, null] }), units: Number.MAX_SAFE_INTEGER, enabled: true, amount: 0.1 };
    const output = await app.procedures["adapter-create"](db, caller, input);
    const created = output.results[0][0];
    assert.equal(created.at, "2026-10-12T00:00:00.123456Z", "declared RETURNING date-time retains microseconds");
    assert.equal(created.day, input.day, "declared RETURNING date retains calendar day");
    assert.deepEqual(created.payload, JSON.parse(input.payload), "JSON text is bound verbatim, not JSON-encoded twice");
    assert.equal(String(created.units), String(input.units), "int8 retains a safe integer exactly");
    assert.equal(created.enabled, true, "PostgreSQL boolean native output"); assert.equal(created.amount, input.amount, "declared number native output"); checks += 6;
    const rows = await app.views["adapter-items"](db, caller, {});
    const count = rows.count;
    assert.ok(Array.isArray(rows), "unsafe returns a row array");
    assert.equal(count, 1, "unsafe array carries affected count");
    assert.equal(rows[0].at, created.at, "declared SELECT date-time retains microseconds");
    assert.equal(rows[0].day, input.day);
    assert.match(rows[0].created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/, "system timestamps have the same wire form");
    // Computed outputs are native: the driver may return Date (milliseconds) or text (microseconds).
    assert.ok(rows[0].computed_at instanceof Date || typeof rows[0].computed_at === "string"); checks += 6;
    await assert.rejects(() => app.procedures["adapter-create"](db, caller, input), { code: "CONFLICT" }); checks++;
    const step = { sql: "UPDATE adapter_items SET key = $1 WHERE id = $2 RETURNING id", binds: ["changed", "missing"], row: true };
    await assert.rejects(() => procedure(db, [step], "adapter/zero"), { code: "CONFLICT" }); checks++;
    const integer = await db.unsafe("SELECT CAST($1 AS bigint) AS positive, CAST($2 AS bigint) AS negative, CAST($3 AS numeric(15,2)) AS decimal", ["9007199254740993", "-9007199254740993", "1234567890123.45"]);
    assert.equal(String(integer[0].positive), "9007199254740993", "unsafe int8 must not be rounded by an adapter");
    assert.equal(String(integer[0].negative), "-9007199254740993");
    assert.equal(integer[0].decimal, "1234567890123.45", "numeric text retains declared scale and precision"); checks += 3;
    const store = app.store(db, caller), collection = store.collection("adapter_items");
    const changed = { sql: "UPDATE adapter_items SET key = $1 WHERE id = $2 RETURNING id", binds: ["transaction", created.id], row: true };
    if (!interactive) {
      let calls = 0;
      const tapped = { unsafe: (sql: string, values: any[]) => { calls++; return db.unsafe(sql, values); }, begin: db.begin.bind(db) };
      const limitedStore = app.store(tapped, caller);
      for (const run of [() => procedure(tapped, [changed, changed], "adapter/multi"), () => limitedStore.transaction(async () => { throw Error("callback must not run"); }), () => limitedStore.batch([limitedStore.collection("adapter_items").update(created.id, { key: "no-write" }, { lock: 1 }), limitedStore.collection("adapter_items").update(created.id, { key: "also-no-write" }, { lock: 1 })])]) {
        await assert.rejects(run, (error: unknown) => {
          const e = error as Error & { code?: string; status?: number };
          return e instanceof Error && e.name === "ContractError" && e.code === "TRANSACTION_UNSUPPORTED" && e.status === 400 && /transaction/i.test(e.message);
        });
        assert.equal(calls, 0, "unsupported interactive transaction refuses before any statement"); checks += 2;
      }
    } else {
      await transaction(db, async tx => {
        await procedure(tx, [changed, changed], "adapter/nested-handle");
        assert.equal((await tx.unsafe("SELECT key FROM adapter_items WHERE id = $1", [created.id]))[0].key, "transaction");
        await assert.rejects(() => transaction(tx, async () => {}), /Nested transactions/);
      }); checks += 2;
      assert.equal((await db.unsafe("SELECT key FROM adapter_items WHERE id = $1", [created.id]))[0].key, "transaction", "begin commits after callback"); checks++;
      const rollback = new Error("rollback sentinel");
      await assert.rejects(() => transaction(db, async tx => { await tx.unsafe("UPDATE adapter_items SET key = $1 WHERE id = $2", ["rolled-back", created.id]); throw rollback; }), error => error === rollback);
      assert.equal((await db.unsafe("SELECT key FROM adapter_items WHERE id = $1", [created.id]))[0].key, "transaction", "begin rolls back callback failure"); checks += 2;
      await store.batch([collection.update(created.id, { key: "batch" }, { lock: 1 })]); checks++;
    }
    const uncertain = { unsafe: db.unsafe.bind(db), begin: async <T>(_options: string, callback: (tx: Postgres) => Promise<T>) => { await callback(db); throw new Error("socket lost at COMMIT"); } };
    await assert.rejects(() => transaction(uncertain, async () => {}), { code: "OUTCOME_UNKNOWN" }); checks++;
    return { checks };
  } finally {
    try { if (client) await client.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
