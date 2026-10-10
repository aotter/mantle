// @ts-nocheck structural fake clients and catalog rows
import { expect, it } from "vitest";
import { postgresRuntimeStorage } from "../../src/postgres/index.js";
import { convergeStorage } from "../../src/postgres/storage.js";
import { PG_URL, freshSchema } from "./engine.js";

const fingerprint = "a".repeat(64);
const fields = { value: "text" };
const plan = (schemas = { records: { fields } }, fp = fingerprint) => ({ schemas, fingerprint: fp });

async function catalog() {
  let booted = null;
  let readOnly = false;
  const sent = [], clients = [];
  const data = { tables: [{ name: "records" }], owned: [{ name: "records" }],
    columns: Object.entries({ _rid: "int8", id: "text", version: "int8", created_at: "timestamptz", updated_at: "timestamptz", author_id: "text", value: "text", extra: "text" })
      .map(([column_name, udt_name]) => ({ table_name: "records", column_name, udt_name })),
    indexes: [{ tbl: "records", name: "_mantle_ix_records_updated", uniq: false, pk: false, partial: false, cols: "updated_at,id" }], checks: [] };
  const connect = async () => {
    const c = { ended: false, async query({ text, values }) {
      sent.push(text);
      if (readOnly && !/^(SELECT|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK)\b/.test(text)) throw Error("runtime attempted a mutation");
      let rows = [];
      if (text.includes("AS datestyle")) rows = [{ role: '"runtime"', db: '"fixture"', datestyle: "ISO, YMD", intervalstyle: "postgres", float_digits: 1, scs: "on", timeout_ms: 10000, tz: "UTC", utc: true, booted }];
      else if (text.startsWith("SELECT value FROM _mantle_boot_state")) rows = booted ? [{ value: booted }] : [];
      else if (text.startsWith("INSERT INTO _mantle_boot_state") && text.includes("'fingerprint'")) booted = values[0];
      else if (readOnly && text.includes("FROM information_schema.tables")) rows = data.tables;
      else if (readOnly && text === "SELECT name FROM _mantle_schema_tables") rows = data.owned;
      else if (readOnly && text.includes("FROM information_schema.columns")) rows = data.columns;
      else if (readOnly && text.includes("FROM pg_index")) rows = data.indexes;
      else if (readOnly && text.includes("FROM pg_constraint")) rows = data.checks;
      return { rows, fields: [], rowCount: rows.length };
    }, async end() { c.ended = true; } };
    clients.push(c); return c;
  };
  // Capture the real Core function/layout signature, rather than inventing boot metadata.
  await convergeStorage(connect, {}, { fingerprint: "b".repeat(64) });
  readOnly = true; sent.length = 0; clients.length = 0;
  return { connect, data, sent, clients, state: () => booted, setState: value => { booted = value; } };
}

it("a retained plan cold-boots read-only after additive migration without rewriting the deployment fingerprint", async () => {
  const db = await catalog(), before = db.state();
  const ready = await postgresRuntimeStorage({ connect: db.connect }).prepare(plan());
  expect(ready.executor).toBeDefined();
  expect(db.state()).toBe(before);
  expect(db.sent).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  expect(db.clients.every(client => client.ended)).toBe(true);
});

it("matching fingerprints do not bypass physical ownership, column, index or check compatibility", async () => {
  for (const change of [db => { db.data.owned = []; }, db => { db.data.columns = db.data.columns.filter(c => c.column_name !== "value"); },
    db => { db.data.columns.find(c => c.column_name === "value").udt_name = "int8"; }, db => { db.data.indexes[0].cols = "value"; },
    db => { db.data.checks = [{ tbl: "records", name: "_mantle_chk_records_0", comment: "mantle:value <> ''" }]; }]) {
    const db = await catalog(); change(db);
    await expect(postgresRuntimeStorage({ connect: db.connect }).prepare(plan({}, db.state().split("|")[0])))
      .resolves.toBeDefined();
    await expect(postgresRuntimeStorage({ connect: db.connect }).prepare(plan(undefined, db.state().split("|")[0])))
      .rejects.toMatchObject({ diagnostics: [expect.objectContaining({ phase: "boot" })] });
    expect(db.clients.every(client => client.ended)).toBe(true);
  }
});

it("missing or incompatible Core function/layout signatures fail before catalog readiness", async () => {
  for (const mutate of [() => null, s => s.replace(/\|[^|]+\|/, "|ffffffff|"), s => s.replace(/\|[^|]+$/, "|999"), s => s + "|extra"]) {
    const db = await catalog(); db.setState(mutate(db.state()));
    await expect(postgresRuntimeStorage({ connect: db.connect }).prepare(plan())).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: "STORAGE_CHANGE_BLOCKED" })] });
    expect(db.sent.some(text => text.includes("information_schema"))).toBe(false);
    expect(db.clients.every(client => client.ended)).toBe(true);
  }
});

it.skipIf(!PG_URL)("native PG retained cold boot and rollback stay read-only after a nullable column is added", async () => {
  const db = await freshSchema();
  try {
    await convergeStorage(db.connect, plan().schemas, { fingerprint });
    await convergeStorage(db.connect, { records: { fields: { ...fields, note: "text" } } }, { fingerprint: "b".repeat(64) });
    const sql = [];
    const connect = async () => {
      const client = await db.connect();
      return { ...client, query: async q => {
        sql.push(q.text);
        if (!/^(SELECT|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK)\b/.test(q.text)) throw Error("runtime attempted a mutation");
        return client.query(q);
      }, end: () => client.end() };
    };
    await postgresRuntimeStorage({ connect }).prepare(plan());
    await postgresRuntimeStorage({ connect }).prepare(plan());
    expect(sql.every(text => !/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/.test(text))).toBe(true);
    const client = await db.connect();
    try { expect((await client.query({ text: "SELECT value FROM _mantle_boot_state WHERE key='fingerprint'" })).rows[0].value.startsWith("b".repeat(64) + "|")).toBe(true); }
    finally { await client.end(); }
  } finally { await db.drop(); }
});
