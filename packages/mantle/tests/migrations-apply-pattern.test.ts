/**
 * The PostgreSQL apply pattern of docs/handbook/guides/migrations.md is application code, not Core's; this test runs the
 * page's own block so the documented code works, with Bun.SQL and postgres.js, when MANTLE_NEXT_BUN_PG_URL or
 * MANTLE_PG_URL is set (`pnpm with-pg`). Concurrent callers apply each migration once; a changed applied migration is
 * refused.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import postgres from "postgres";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Postgres } from "../src/kernel/contracts.js";

const pgUrl = process.env.MANTLE_NEXT_BUN_PG_URL ?? process.env.MANTLE_PG_URL;
const page = resolve(import.meta.dir, "../../../docs/handbook/guides/migrations.md");
type Migration = { id: string; sql: string };
let dir = "";
/** The page's module, imported from its extracted block. */
let pg: { migrate(db: Postgres, migrations: readonly Migration[]): Promise<string[]> };

beforeAll(async () => {
  await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });
  dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/migrate-"));
  const source = await readFile(page, "utf8");
  for (const [, block] of source.matchAll(/^```ts\n([\s\S]*?)^```$/gm)) {
    const name = block!.match(/^\/\/ src\/([\w-]+)\.ts/)?.[1];
    if (name) await writeFile(join(dir, `${name}.ts`), block!);
  }
  pg = await import(join(dir, "migrate-postgres.ts"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const migrations: Migration[] = [
  {
    id: "0001_notes",
    sql: "CREATE TABLE notes (id TEXT PRIMARY KEY, label TEXT NOT NULL);\nCREATE INDEX notes_label ON notes (label);\n",
  },
  { id: "0002_notes_body", sql: "ALTER TABLE notes ADD COLUMN body TEXT;\n" },
];

/** Each client as the `Postgres` handle generated code takes, and how to end it. */
const clients: [string, () => [Postgres, () => Promise<void>]][] = [
  [
    "Bun.SQL",
    () => {
      const db = new SQL(pgUrl!, { max: 1 });
      return [db as unknown as Postgres, () => db.close()];
    },
  ],
  [
    "postgres.js",
    () => {
      const db = postgres(pgUrl!, { max: 1, onnotice: () => {} });
      return [db as unknown as Postgres, () => db.end()];
    },
  ],
];
for (const [name, connect] of clients)
  (pgUrl ? test : test.skip)(
    `PostgreSQL (${name}): concurrent callers apply each migration once; the states converge; edits are refused`,
    async () => {
      const namespace = `migrate_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const scoped = migrations.map(m => ({ ...m, sql: m.sql.replace(/(TABLE|ON) notes/g, `$1 ${namespace}.notes`) }));
      const ledger = (db: Postgres) =>
        db.unsafe(`SELECT id FROM app_migrations WHERE id LIKE '${namespace}%' ORDER BY id`, []);
      const ids = scoped.map(m => ({ ...m, id: `${namespace}_${m.id}` }));
      const [a, endA] = connect(),
        [b, endB] = connect();
      try {
        await a.unsafe(`CREATE SCHEMA ${namespace}`, []);
        expect(await pg.migrate(a, ids.slice(0, 1))).toEqual([ids[0]!.id]);
        const [first, second] = await Promise.all([pg.migrate(a, ids), pg.migrate(b, ids)]);
        expect([...first, ...second]).toEqual([ids[1]!.id]);
        expect(await pg.migrate(a, ids)).toEqual([]);
        expect((await ledger(a)).map((row: { id: string }) => row.id)).toEqual(ids.map(m => m.id));
        const columns = await a.unsafe(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'notes' ORDER BY column_name",
          [namespace],
        );
        expect(columns.map((row: { column_name: string }) => row.column_name)).toEqual(["body", "id", "label"]);
        const edited = [{ ...ids[0]!, sql: ids[0]!.sql + "-- edited\n" }, ids[1]!];
        await expect(pg.migrate(a, edited)).rejects.toThrow("was applied with different text");
        // a failing migration keeps nothing, its ledger row included
        const broken = [
          ...ids,
          { id: `${namespace}_0003`, sql: `CREATE TABLE ${namespace}.extra (a TEXT); SELECT * FROM missing_table;` },
        ];
        await expect(pg.migrate(a, broken)).rejects.toThrow();
        expect([...(await a.unsafe("SELECT to_regclass($1) AS t", [`${namespace}.extra`]))]).toEqual([{ t: null }]);
        expect((await ledger(a)).length).toBe(2);
      } finally {
        await a.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`, []);
        await a.unsafe(`DELETE FROM app_migrations WHERE id LIKE '${namespace}%'`, []).then(
          () => {},
          () => {},
        );
        await endA();
        await endB();
      }
    },
  );
