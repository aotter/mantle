import { afterEach, beforeAll, expect, it } from "vitest";
import { loadModule, parseSync } from "libpg-query";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { convergeStorage, planStorageChanges, type StorageSchema } from "../../src/core/sql/storage.js";

const expr = (text: string) => (parseSync(`SELECT 1 WHERE ${text}`) as any).stmts[0].stmt.SelectStmt.whereClause;
beforeAll(() => loadModule());

const items: StorageSchema = { scope: "owner", ttl: "expires_at", fields: { name: "text", stock: "integer" }, checks: [expr("stock >= 0")], unique: [["name"]] };
const notes: StorageSchema = { scope: "owner", fields: { title: "text", body: "text", loc: "geo" }, search: ["title", "body"] };

const open: LocalD1[] = [];
async function db() {
  const d1 = await LocalD1.create();
  open.push(d1);
  return d1;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.dispose()));
});
const names = async (d1: LocalD1, type: string) => (await d1.all("SELECT name FROM sqlite_schema WHERE type = ?1 AND name LIKE '\\_mantle\\_%' ESCAPE '\\' ORDER BY name", type)).map((r) => r.name);
const run = (d1: LocalD1, plan: Record<string, StorageSchema>, fingerprint = "f1") => convergeStorage(d1, plan, { fingerprint });

it("creates STRICT tables, indexes, check triggers, FTS5, R*Tree and the time zone table", async () => {
  const d1 = await db();
  expect(await run(d1, { items, notes })).toEqual({ skipped: false, blocked: [], undeclared: [] });
  expect(((await d1.all("SELECT sql FROM sqlite_schema WHERE name = 'items'"))[0] as any).sql).toMatch(/STRICT$/);
  await expect(d1.exec("INSERT INTO items (id, created_at, owner, name, stock) VALUES ('a', 0, 'o', 'x', -1)")).rejects.toThrow(/CHECK items: stock >= 0/);
  await d1.exec("INSERT INTO notes (id, created_at, owner, title, body, loc_lat, loc_lng) VALUES ('n', 0, 'o', '台北小籠包', 'x', 25, 121)");
  expect(await d1.all(`SELECT id FROM notes WHERE _rid IN (SELECT rowid FROM _mantle_fts_notes WHERE _mantle_fts_notes = '"小籠包"')`)).toEqual([{ id: "n" }]);
  expect(await d1.all("SELECT count(*) AS c FROM _mantle_geo_notes_loc")).toEqual([{ c: 1 }]);
  expect(((await d1.all("SELECT count(*) AS c FROM _mantle_tz"))[0] as any).c).toBeGreaterThan(0);
});

it("an unchanged fingerprint reads nothing else", async () => {
  const d1 = await db();
  await run(d1, { items });
  await d1.exec("DROP TABLE items");
  expect((await run(d1, { items })).skipped).toBe(true);
  expect(await d1.all("SELECT name FROM sqlite_schema WHERE name = 'items'")).toEqual([]);
});

it("adds a missing field column, keeps the rows, and reports what is undeclared", async () => {
  const d1 = await db();
  await run(d1, { items });
  await d1.exec("INSERT INTO items (id, created_at, owner, name, stock) VALUES ('a', 0, 'o', 'x', 1)", "ALTER TABLE items ADD COLUMN legacy TEXT", "CREATE INDEX stray ON items (name)");
  const r = await run(d1, { items: { ...items, fields: { ...items.fields, sku: "text" } } }, "f2");
  expect(r.blocked).toEqual([]);
  expect(r.undeclared.map((u) => u.code).sort()).toEqual(["STORAGE_UNDECLARED_COLUMN", "STORAGE_UNDECLARED_INDEX"]);
  expect(await d1.all("SELECT id, sku FROM items")).toEqual([{ id: "a", sku: null }]);
});

it("blocks a changed column type, an undeclared unique index and a table Mantle did not create, and applies nothing", async () => {
  const d1 = await db();
  await d1.exec("CREATE TABLE items (id TEXT, owner TEXT)", "CREATE TABLE other (id TEXT)");
  const r = await run(d1, { items, other: { fields: {} } });
  expect(r.blocked.map((b) => b.code)).toEqual(["STORAGE_TABLE_NOT_OWNED", "STORAGE_TABLE_NOT_OWNED"]);
  expect(await names(d1, "table")).not.toContain("_mantle_fts_notes");

  const e = await db();
  await run(e, { items });
  await e.exec("ALTER TABLE items ADD COLUMN sku TEXT", "CREATE UNIQUE INDEX loose ON items (sku)");
  const changed = await run(e, { items: { ...items, fields: { name: "text", stock: "real", sku: "text" } } }, "f2");
  expect(changed.blocked.map((b) => b.message).join("\n")).toMatch(/items\.stock is INTEGER.*REAL[\s\S]*undeclared unique index loose/);
});

it("a unique index that existing rows break is blocked and nothing is applied", async () => {
  const d1 = await db();
  await run(d1, { items: { ...items, unique: [] } });
  await d1.exec("INSERT INTO items (id, created_at, owner, name, stock) VALUES ('a', 0, 'o', 'x', 1), ('b', 0, 'o', 'x', 1)");
  const r = await run(d1, { items, notes }, "f2");
  expect(r.blocked.map((b) => b.message).join()).toMatch(/_mantle_uq_items_0.*existing rows/);
  expect(await names(d1, "table")).not.toContain("_mantle_fts_notes"); // the batch rolled back
});

it("rebuilds the search table when its fields change and drops it when search goes away", async () => {
  const d1 = await db();
  await run(d1, { notes: { ...notes, search: ["title"] } });
  await d1.exec("INSERT INTO notes (id, created_at, owner, title, body) VALUES ('n', 0, 'o', 'abc', 'hello world')");
  await run(d1, { notes }, "f2");
  expect(await d1.all(`SELECT id FROM notes WHERE _rid IN (SELECT rowid FROM _mantle_fts_notes WHERE _mantle_fts_notes = '"hello"')`)).toEqual([{ id: "n" }]);
  await run(d1, { notes: { ...notes, search: undefined } }, "f3");
  expect(await names(d1, "table")).not.toContain("_mantle_fts_notes");
  expect((await names(d1, "trigger")).filter((n) => n.startsWith("_mantle_fts_"))).toEqual([]);
});

it("refuses Schema names the platform owns, in any letter case, and never adopts a foreign table by case", async () => {
  const d1 = await db();
  await d1.exec("CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT)");
  const r = await run(d1, { User: { fields: {} }, session: { fields: {} }, _mantle_x: { fields: {} } });
  expect(r.blocked.map((b) => [b.schema, b.code])).toEqual([["User", "STORAGE_TABLE_NOT_OWNED"], ["session", "STORAGE_TABLE_NOT_OWNED"], ["_mantle_x", "STORAGE_TABLE_NOT_OWNED"]]);
  expect(await d1.all("SELECT name FROM _mantle_schema_tables")).toEqual([]);
});

it("planStorageChanges prints what convergence would apply, as replayable SQL, and applies nothing", async () => {
  const d1 = await db();
  const schema = () => d1.all("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name");
  // a database Mantle never booted: no registry to read, and none is created
  const fresh = await planStorageChanges(d1, { items });
  expect(await schema()).toEqual([]);
  expect(fresh.sql).toContain("INSERT OR IGNORE INTO _mantle_schema_tables (name) VALUES ('items')");
  // replaying the printed SQL converges the tables, so boot then applies no Schema change
  for (const sql of fresh.sql) await d1.exec(sql);
  expect((await planStorageChanges(d1, { items })).sql).toEqual([]);

  const before = await schema();
  const added = await planStorageChanges(d1, { items: { ...items, fields: { ...items.fields, sku: "text" } } });
  expect(added.sql).toEqual(['ALTER TABLE "items" ADD COLUMN "sku" TEXT']);
  expect(await schema()).toEqual(before);
});

it("planStorageChanges skips a database that already booted the fingerprint, as boot does", async () => {
  const d1 = await db();
  await run(d1, { items }, "f1");
  const changed = { items: { ...items, fields: { ...items.fields, sku: "text" } } };
  expect(await planStorageChanges(d1, changed, { fingerprint: "f1" })).toEqual({ skipped: true, sql: [], blocked: [], undeclared: [] });
  expect((await planStorageChanges(d1, changed, { fingerprint: "f2" })).sql).toEqual(['ALTER TABLE "items" ADD COLUMN "sku" TEXT']);
});
