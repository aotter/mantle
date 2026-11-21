/**
 * docs/handbook/guides/migrations.md and ADR-lite #2108. Core ships no migration tooling; its opening is a deterministic,
 * diffable schema.sql. This test holds that opening (same input, same bytes; each change is a local diff) and keeps the
 * guide honest: each of its example migrations, applied to a database built from the old schema.sql with rows in it,
 * gives the same structure as a fresh database built from the new one, on bun:sqlite and, when MANTLE_NEXT_BUN_PG_URL
 * or MANTLE_PG_URL is set (`pnpm with-pg`), on PostgreSQL.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateFromSources } from "../src/infrastructure/generateAuth.js";

const pgUrl = process.env.MANTLE_NEXT_BUN_PG_URL ?? process.env.MANTLE_PG_URL;
if (!pgUrl)
  console.warn("migrations-guide: PostgreSQL apply-and-compare SKIPPED (no MANTLE_NEXT_BUN_PG_URL or MANTLE_PG_URL)");

type Doc = Record<string, any>;
type Dialect = "sqlite" | "postgres";
type Options = Omit<Parameters<typeof generateFromSources>[0], "target" | "sources">;
const guide = readFileSync(resolve(import.meta.dir, "../../../docs/handbook/guides/migrations.md"), "utf8");

/** The guide's starting manifest and its example migrations, keyed by "<dialect>: <title>". */
const base: Doc = Bun.YAML.parse(guide.match(/^```yaml\n([\s\S]*?)^```$/m)![1]!) as Doc;
const examples = new Map<string, string>();
for (const [, dialects, title, sql] of guide.matchAll(
  /^ *```sql\n *-- ((?:sqlite|postgres)(?:, (?:sqlite|postgres))?): (.+)\n([\s\S]*?)^ *```$/gm,
))
  for (const dialect of dialects!.split(", ")) examples.set(`${dialect}: ${title}`, sql!);

/** The starting manifest with spec keys, extra fields and a replaced `required` list. */
function notes(spec: Doc = {}, properties: Doc = {}, required?: string[]): Doc {
  const s = structuredClone(base);
  Object.assign(s.spec, spec);
  Object.assign(s.spec.schema.properties, properties);
  if (required) s.spec.schema.required = required;
  return s;
}
const schema = (name: string, properties: Doc, required: string[]): Doc => ({
  apiVersion: "cms.mantle.aotter.net/v2",
  kind: "Schema",
  metadata: { name },
  spec: { title: name, lifecycle: "operational", schema: { type: "object", required, properties } },
});

async function generated(dialect: Dialect, docs: Doc[], options: Options = {}): Promise<string> {
  const result = await generateFromSources({
    target: dialect === "sqlite" ? "bun-sqlite" : "bun-postgres",
    sources: { sources: docs.map((doc, i) => ({ sourceId: `${i}.json`, text: JSON.stringify(doc) })) },
    ...options,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.files["schema.sql"]!;
}

/** The lines a line diff (longest common subsequence) removes and adds, as `git diff` shows them. */
function lineDiff(before: string, after: string) {
  const a = before.split("\n"),
    b = after.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const removed: string[] = [],
    added: string[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length)
    if (i < a.length && j < b.length && a[i] === b[j]) i++, j++;
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) added.push(b[j++]!);
    else removed.push(a[i++]!);
  return { removed: removed.filter(Boolean), added: added.filter(Boolean) };
}

describe("schema.sql is deterministic", () => {
  for (const dialect of ["sqlite", "postgres"] as const)
    test(`${dialect}: same input, same bytes; key order and required order do not matter`, async () => {
      const docs = [
        notes(
          { indexes: [["rank", "id"]], checks: ["rank >= 0"], searchableFields: ["label"] },
          { body: { type: "string" } },
          ["label", "rank"],
        ),
      ];
      const first = await generated(dialect, docs, { admin: true, auth: [{}] });
      expect(await generated(dialect, docs, { admin: true, auth: [{}] })).toBe(first);
      // the same manifest with every object's keys reversed and `required` reordered
      const reversed = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(reversed)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value)
                  .reverse()
                  .map(([k, v]) => [k, k === "properties" ? v : reversed(v)]),
              )
            : value;
      const shuffled = reversed(docs[0]) as Doc;
      shuffled.spec.schema.required = ["rank", "label"];
      expect(await generated(dialect, [shuffled], { admin: true, auth: [{}] })).toBe(first);
      expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}|\/tmp\/|\b\d+\.\d+\.\d+\b/);
    });
});

/** Each change against the guide's starting manifest, and what its diff must be: added lines only, or a changed table. */
const LOCAL: { name: string; after: Doc[]; options?: Options; changesTable?: Dialect[] }[] = [
  {
    name: "a new optional field",
    after: [notes({}, { body: { type: "string" } })],
    changesTable: ["sqlite", "postgres"],
  },
  { name: "a new index", after: [notes({ indexes: [["rank", "id"]] })] },
  { name: "an index appended after an existing one", after: [notes({ indexes: [["rank", "id"]] })] },
  { name: "a new unique index", after: [notes({ uniqueIndexes: [["label"]] })] },
  { name: "a new check", after: [notes({ checks: ["rank >= 0"] })] },
  { name: "search", after: [notes({ searchableFields: ["label"] })] },
  {
    name: "a geo field",
    after: [notes({}, { at: { type: "object", format: "geo" } })],
    changesTable: ["sqlite", "postgres"],
  },
  { name: "a new Schema", after: [notes(), schema("tags", { name: { type: "string" } }, ["name"])] },
  { name: "--admin", after: [notes()], options: { admin: true } },
  { name: "--auth", after: [notes()], options: { auth: [{}] } },
  { name: "--site", after: [notes()], options: { site: { brand: "B", title: "T", description: "D" } as never } },
];

describe("each change is a local diff of schema.sql", () => {
  for (const dialect of ["sqlite", "postgres"] as const)
    for (const c of LOCAL)
      test(`${dialect}: ${c.name}`, async () => {
        const before =
          c.name === "an index appended after an existing one"
            ? await generated(dialect, [notes({ indexes: [["label", "id"]] })])
            : await generated(dialect, [notes()]);
        const after =
          c.name === "an index appended after an existing one"
            ? await generated(dialect, [
                notes({
                  indexes: [
                    ["label", "id"],
                    ["rank", "id"],
                  ],
                }),
              ])
            : await generated(dialect, c.after, c.options);
        const { removed, added } = lineDiff(before, after);
        if (c.changesTable?.includes(dialect)) {
          // a new column changes its table's CREATE TABLE line, and only that line is removed
          expect(removed).toHaveLength(1);
          expect(removed[0]).toMatch(/^CREATE TABLE (IF NOT EXISTS )?"notes" /);
          expect(added[0]).toMatch(/^CREATE TABLE (IF NOT EXISTS )?"notes" /);
        } else expect(removed).toEqual([]);
        if (!(dialect === "postgres" && c.name === "search")) expect(added.length).toBeGreaterThan(0);
      });

  test("an index inserted before an existing one renames it (append instead)", async () => {
    const before = await generated("sqlite", [notes({ indexes: [["rank", "id"]] })]);
    const after = await generated("sqlite", [
      notes({
        indexes: [
          ["label", "id"],
          ["rank", "id"],
        ],
      }),
    ]);
    expect(lineDiff(before, after).removed).toEqual([
      `CREATE INDEX IF NOT EXISTS "_mantle_ix_notes_0" ON "notes" ("rank", "id");`,
    ]);
  });
});

/** Tables (columns by name: ADD COLUMN appends), indexes, triggers and virtual tables, as SQLite records them. */
function sqliteShape(db: Database) {
  const objects = db
    .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
    )
    .all();
  return objects.map(o => {
    if (o.type !== "table") return o;
    const ident = `"${o.name.replaceAll('"', '""')}"`;
    return {
      name: o.name,
      virtual: o.sql?.startsWith("CREATE VIRTUAL") ? o.sql : false,
      columns: db
        .query(`PRAGMA table_xinfo(${ident})`)
        .all()
        .map(({ cid: _, ...c }: any) => c)
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      strict: db.query<{ strict: number }, []>(`PRAGMA table_list(${ident})`).get()?.strict,
      foreignKeys: db
        .query(`PRAGMA foreign_key_list(${ident})`)
        .all()
        .map(({ id: _, seq: __, ...f }: any) => f),
      indexes: db
        .query(`PRAGMA index_list(${ident})`)
        .all()
        .map(({ seq: _, ...i }: any) => ({
          ...i,
          columns: db
            .query(`PRAGMA index_xinfo("${i.name}")`)
            .all()
            .map((c: any) => [c.name, c.desc, c.key]),
        }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
    };
  });
}

/** Columns, indexes and constraints of one PostgreSQL schema, with the schema name removed. */
async function postgresShape(db: SQL, namespace: string) {
  const strip = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(`${namespace}.`, ""));
  return strip({
    columns: await db.unsafe(
      `SELECT table_name, column_name, data_type, is_nullable, column_default, collation_name, is_identity, identity_generation
       FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, column_name`,
      [namespace],
    ),
    indexes: await db.unsafe(
      "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname",
      [namespace],
    ),
    constraints: await db.unsafe(
      `SELECT c.relname, k.conname, k.contype, k.convalidated, pg_get_constraintdef(k.oid) AS definition
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 ORDER BY c.relname, k.conname`,
      [namespace],
    ),
  });
}

const rows: Record<Dialect, string> = {
  sqlite: `INSERT INTO notes (id, created_at, label, rank) VALUES ('n1', 0, 'hello world', 1)`,
  postgres: `INSERT INTO notes (id, created_at, label, rank) VALUES ('n1', now(), 'hello world', 1)`,
};

/** Old database with rows plus the migration, and a fresh database from the new schema, on bun:sqlite. */
function applySqlite(before: string, after: string, migration: string, data = rows.sqlite) {
  const old = new Database(":memory:"),
    fresh = new Database(":memory:");
  try {
    old.exec(before);
    old.exec(data);
    if (migration) old.transaction(() => old.exec(migration)).immediate();
    fresh.exec(after);
    return { migrated: sqliteShape(old), fresh: sqliteShape(fresh), db: old };
  } finally {
    fresh.close();
  }
}

async function applyPostgres(before: string, after: string, migration: string, data = rows.postgres) {
  const db = new SQL(pgUrl!, { max: 1 });
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12),
    old = `mig_old_${id}`,
    fresh = `mig_new_${id}`;
  try {
    await db.unsafe(`CREATE SCHEMA ${old}; CREATE SCHEMA ${fresh}`);
    await db.unsafe(`SET search_path TO ${old}`);
    await db.unsafe(before);
    await db.unsafe(data);
    await db.unsafe(migration);
    await db.unsafe(`SET search_path TO ${fresh}`);
    await db.unsafe(after);
    await db.unsafe("SET search_path TO public");
    return { migrated: await postgresShape(db, old), fresh: await postgresShape(db, fresh) };
  } finally {
    await db.unsafe(`DROP SCHEMA IF EXISTS ${old} CASCADE; DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    await db.close();
  }
}

async function expectSameShape(dialect: Dialect, before: string, after: string, migration: string) {
  if (dialect === "sqlite") {
    const { migrated, fresh, db } = applySqlite(before, after, migration);
    db.close();
    expect(migrated).toEqual(fresh);
  } else {
    const { migrated, fresh } = await applyPostgres(before, after, migration);
    expect(migrated).toEqual(fresh);
  }
}

/** The guide's examples: the manifest each one migrates to. */
const EXAMPLES: Record<string, Doc[]> = {
  "a new optional field": [notes({}, { body: { type: "string" } })],
  "a new index": [notes({ indexes: [["rank", "id"]] })],
  "a new unique index": [notes({ uniqueIndexes: [["label"]] })],
  "a new check": [notes({ checks: ["rank >= 0"] })],
  "a new check, validated separately": [notes({ checks: ["rank >= 0"] })],
  "a geo field": [notes({}, { at: { type: "object", format: "geo" } })],
  "search on an existing Schema": [notes({ searchableFields: ["label"] })],
  "a new field every row must have, enforced by a check": [
    notes({ checks: ["body IS NOT NULL"] }, { body: { type: "string" } }),
  ],
  "a new required field": [notes({}, { body: { type: "string" } }, ["label", "body"])],
  "publishing turned on": [notes({ lifecycle: "publishing" })],
  "publishing turned on (a table rebuild)": [notes({ lifecycle: "publishing" })],
};

test("every example in the guide is tested here, and every tested example is in the guide", () => {
  expect(examples.size).toBeGreaterThan(10);
  for (const key of examples.keys()) expect(Object.keys(EXAMPLES)).toContain(key.replace(/^\w+: /, ""));
  for (const title of Object.keys(EXAMPLES))
    expect([...examples.keys()].some(key => key.endsWith(`: ${title}`))).toBe(true);
});

for (const dialect of ["sqlite", "postgres"] as const)
  describe(`${dialect}: the guide's example migration on a database with rows = a fresh database`, () => {
    for (const [title, after] of Object.entries(EXAMPLES)) {
      const migration = examples.get(`${dialect}: ${title}`);
      if (!migration) continue;
      (dialect === "postgres" && !pgUrl ? test.skip : test)(title, async () => {
        await expectSameShape(dialect, await generated(dialect, [notes()]), await generated(dialect, after), migration);
      });
    }
    // The table's first row: when the diff only adds statements, they are the migration.
    for (const c of LOCAL.filter(c => !c.changesTable && c.name !== "an index appended after an existing one"))
      (dialect === "postgres" && !pgUrl ? test.skip : test)(
        `added statements applied as they are: ${c.name}`,
        async () => {
          const before = await generated(dialect, [notes()]),
            after = await generated(dialect, c.after, c.options);
          await expectSameShape(dialect, before, after, lineDiff(before, after).added.join("\n"));
        },
      );
    (dialect === "postgres" && !pgUrl ? test.skip : test)(
      "the comparison sees a migration that leaves something out",
      async () => {
        const before = await generated(dialect, [notes()]);
        for (const after of [EXAMPLES["a new optional field"]!, EXAMPLES["a new index"]!, EXAMPLES["a new check"]!]) {
          if (dialect === "sqlite") {
            const shapes = applySqlite(before, await generated(dialect, after), "");
            shapes.db.close();
            expect(shapes.migrated).not.toEqual(shapes.fresh);
          } else {
            const shapes = await applyPostgres(before, await generated(dialect, after), "");
            expect(shapes.migrated).not.toEqual(shapes.fresh);
          }
        }
      },
    );
  });

describe("the guide's claims about existing rows", () => {
  test("sqlite: the search rebuild indexes rows already stored", async () => {
    const { db } = applySqlite(
      await generated("sqlite", [notes()]),
      await generated("sqlite", EXAMPLES["search on an existing Schema"]!),
      examples.get("sqlite: search on an existing Schema")!,
    );
    try {
      expect(db.query("SELECT rowid FROM _mantle_fts_notes WHERE _mantle_fts_notes MATCH 'hello'").all()).toEqual([
        { rowid: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  test("sqlite: the table rebuild keeps rows and makes them drafts; a check leaves stored rows unchecked", async () => {
    const before = await generated("sqlite", [notes()]);
    const rebuilt = applySqlite(
      before,
      await generated("sqlite", EXAMPLES["publishing turned on"]!),
      examples.get("sqlite: publishing turned on (a table rebuild)")!,
    );
    try {
      expect(rebuilt.db.query("SELECT _rid, id, label, status FROM notes").all()).toEqual([
        { _rid: 1, id: "n1", label: "hello world", status: "draft" },
      ]);
    } finally {
      rebuilt.db.close();
    }
    const checked = applySqlite(
      before,
      await generated("sqlite", EXAMPLES["a new check"]!),
      examples.get("sqlite: a new check")!,
      rows.sqlite.replace(", 1)", ", -1)"),
    );
    try {
      expect(checked.db.query("SELECT rank FROM notes").all()).toEqual([{ rank: -1 }]);
      expect(() => checked.db.exec("UPDATE notes SET label = 'x'")).toThrow(/MANTLE_CHECK/);
    } finally {
      checked.db.close();
    }
  });

  test("sqlite: on a table with rows, ADD COLUMN refuses NOT NULL without a default; it always refuses UNIQUE", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE t (a TEXT) STRICT; INSERT INTO t VALUES ('x')");
      expect(() => db.exec("ALTER TABLE t ADD COLUMN b TEXT NOT NULL")).toThrow(/NOT NULL/);
      expect(() => db.exec("ALTER TABLE t ADD COLUMN b TEXT UNIQUE")).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  for (const dialect of ["sqlite", "postgres"] as const)
    (dialect === "postgres" && !pgUrl ? test.skip : test)(
      `${dialect}: a unique index fails on duplicates, which the guide's query finds first`,
      async () => {
        const query = guide.match(/^SELECT "label", count\(\*\) .*$/m)![0];
        const duplicates = [rows[dialect], rows[dialect].replace("'n1'", "'n2'")].join(";\n");
        const before = await generated(dialect, [notes()]),
          after = await generated(dialect, EXAMPLES["a new unique index"]!);
        const migration = examples.get(`${dialect}: a new unique index`)!;
        if (dialect === "sqlite") {
          const db = new Database(":memory:");
          db.exec(before);
          db.exec(duplicates);
          expect(db.query(query).all()).toEqual([{ label: "hello world", "count(*)": 2 }]);
          db.close();
          expect(() => applySqlite(before, after, migration, duplicates)).toThrow(/UNIQUE/);
        } else await expect(applyPostgres(before, after, migration, duplicates)).rejects.toThrow(/duplicate|unique/i);
      },
    );

  (pgUrl ? test : test.skip)(
    "postgres: a new check fails when an existing row violates it; a required column needs a fill",
    async () => {
      const before = await generated("postgres", [notes()]);
      await expect(
        applyPostgres(
          before,
          await generated("postgres", EXAMPLES["a new check"]!),
          examples.get("postgres: a new check")!,
          rows.postgres.replace(", 1)", ", -1)"),
        ),
      ).rejects.toThrow(/violated|check constraint/i);
      await expect(
        applyPostgres(before, before, `ALTER TABLE "notes" ADD COLUMN "body" text COLLATE "C" NOT NULL`),
      ).rejects.toThrow(/null values|contains null/i);
    },
  );
});
