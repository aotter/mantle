import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  buildDdl,
  schemaIndexedFieldSql,
  type SchemaManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type {
  BatchResult,
  DatabaseDriver,
  Migration,
  PreparedStatement,
  RunResult,
} from "../src/domain/port/DatabaseDriver.js";
import { compileView } from "../src/domain/service/ViewSqlCompiler.js";
import {
  reconcileSchemaIndexes,
  schemaIndexMigrations,
} from "../src/infrastructure/boot/index.js";
import { DatabaseEntryRepository } from "../src/infrastructure/persistence/DatabaseEntryRepository.js";
import { ExecuteViewUseCase } from "../src/usecase/view/ExecuteViewUseCase.js";

const schema = {
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name: "account-members" },
  spec: {
    title: "Account members",
    schema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        state: { type: "string" },
        accountId: { type: "string" },
        email: { type: "string" },
        role: { type: "string" },
      },
    },
    indexes: [
      ["userId", "state", "accountId"],
      ["accountId", "state", "userId"],
    ],
    uniqueIndexes: [
      ["accountId", "userId"],
      ["accountId", "email"],
    ],
  },
} as SchemaManifest;

interface IndexListRow {
  readonly name: string;
  readonly unique: number;
}

interface IndexXInfoRow {
  readonly seqno: number;
  readonly name: string | null;
  readonly key: number;
}

interface QueryPlanRow {
  readonly detail: string;
}

interface RecordedExecution {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function view(spec: Partial<ViewManifest["spec"]>): ViewManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "View",
    metadata: { name: "account-member-query" },
    spec: { from: schema.metadata.name, ...spec },
  };
}

function sqliteParams(params: readonly unknown[]): SQLInputValue[] {
  return [...params] as SQLInputValue[];
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function indexedColumn(field: string): string {
  const sql = schemaIndexedFieldSql(schema, field);
  if (!sql || !sql.startsWith('"') || !sql.endsWith('"')) {
    throw new Error(`expected a quoted indexed field reference for ${field}`);
  }
  return sql.slice(1, -1).replace(/""/g, '"');
}

function indexColumns(db: DatabaseSync, indexName: string): readonly string[] {
  return (db.prepare(
    `PRAGMA index_xinfo(${sqliteStringLiteral(indexName)})`,
  ).all() as unknown as IndexXInfoRow[])
    .filter((row) => row.key === 1)
    .sort((a, b) => a.seqno - b.seqno)
    .map((row) => row.name)
    .filter((name): name is string => name !== null);
}

function findIndex(
  db: DatabaseSync,
  fields: readonly string[],
  unique: boolean,
): IndexListRow {
  const wanted = fields.map(indexedColumn);
  const indexes = db.prepare("PRAGMA index_list('entries')").all() as unknown as IndexListRow[];
  const found = indexes.find(
    (index) => Boolean(index.unique) === unique &&
      JSON.stringify(indexColumns(db, index.name)) === JSON.stringify(wanted),
  );
  if (!found) throw new Error(`index not found for ${fields.join(", ")}`);
  return found;
}

function planDetails(
  db: DatabaseSync,
  compiled: ReturnType<typeof compileView>,
): readonly string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
    .all(...sqliteParams(compiled.params)) as unknown as QueryPlanRow[])
    .map((row) => row.detail);
}

function createSqliteDriver(
  db: DatabaseSync,
  executions: RecordedExecution[],
): DatabaseDriver {
  const statement = (
    sql: string,
    params: readonly unknown[] = [],
  ): PreparedStatement => ({
    bind: (...next) => statement(sql, next),
    async first<T>(): Promise<T | null> {
      executions.push({ sql, params });
      const row = db.prepare(sql).get(...sqliteParams(params));
      return (row as T | undefined) ?? null;
    },
    async all<T>(): Promise<readonly T[]> {
      executions.push({ sql, params });
      return db.prepare(sql).all(...sqliteParams(params)) as unknown as T[];
    },
    async run(): Promise<RunResult> {
      executions.push({ sql, params });
      const result = db.prepare(sql).run(...sqliteParams(params));
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });

  return {
    prepare: (sql) => statement(sql),
    async batch(statements): Promise<readonly BatchResult[]> {
      const results: BatchResult[] = [];
      for (const prepared of statements) {
        const result = await prepared.run();
        results.push(result);
      }
      return results;
    },
    migrations: {
      async runAll(_migrations: readonly Migration[]): Promise<void> {},
    },
  };
}

function createEntriesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE entries (
      id          TEXT PRIMARY KEY,
      collection  TEXT NOT NULL,
      status      TEXT NOT NULL,
      version     INTEGER NOT NULL,
      data        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      author_id   TEXT
    )
  `);
}

describe("declared Schema indexes against real SQLite", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    createEntriesTable(db);

    // Populate the legacy table before applying generated columns and indexes,
    // proving ALTER TABLE works for an existing D1-shaped database.
    const insert = db.prepare(
      `INSERT INTO entries
       (id, collection, status, version, data, created_at, updated_at, author_id)
       VALUES (?, ?, ?, 1, ?, ?, ?, NULL)`,
    );
    for (let account = 0; account < 50; account += 1) {
      insert.run(`a${account}`, "accounts", "published", "{}", account, account);
    }
    for (let i = 0; i < 5_000; i += 1) {
      insert.run(
        `m${i}`,
        schema.metadata.name,
        "published",
        JSON.stringify({
          userId: `u${i % 100}`,
          state: i % 4 === 0 ? "disabled" : "active",
          accountId: `a${Math.floor(i / 100)}`,
          email: `member${i}@example.test`,
          role: i % 3 === 0 ? "owner" : "member",
        }),
        i,
        i,
      );
    }
    insert.run(
      "m-missing-account",
      schema.metadata.name,
      "published",
      JSON.stringify({ userId: "u-missing", state: "active", role: "member" }),
      5_001,
      5_001,
    );
    for (let i = 0; i < 250; i += 1) {
      insert.run(
        `p${i}`,
        "posts",
        "published",
        JSON.stringify({ userId: `u${i % 100}`, state: "active", accountId: "a1" }),
        i,
        i,
      );
    }

    const ddl = buildDdl(schema);
    for (const column of ddl.columns) db.exec(column.sql);
    for (const index of ddl.indexes) db.exec(index.sql);
    db.exec("ANALYZE");
  });

  afterAll(() => db.close());

  it("uses leftmost prefixes and avoids the account-member temp sort", () => {
    const actorIndex = findIndex(db, ["userId", "state", "accountId"], false);
    const accountIndex = findIndex(db, ["accountId", "state", "userId"], false);
    const userId = indexedColumn("userId");
    const state = indexedColumn("state");
    const accountId = indexedColumn("accountId");

    const prefix = compileView(view({
      fields: ["id"],
      filter: {
        and: [
          { eq: { field: "userId", value: "u1" } },
          { eq: { field: "state", value: "active" } },
        ],
      },
    }), {}, schema);
    const prefixPlan = planDetails(db, prefix).join("\n");
    expect(prefixPlan).toContain(`SEARCH entries USING INDEX ${actorIndex.name}`);
    expect(prefixPlan).toContain(`${userId}=? AND ${state}=?`);

    const missingTrailingField = compileView(
      view({
        fields: ["id"],
        filter: {
          and: [
            { eq: { field: "userId", value: "u-missing" } },
            { eq: { field: "state", value: "active" } },
          ],
        },
      }),
      {},
      schema,
    );
    expect(planDetails(db, missingTrailingField).join("\n")).toContain(
      `SEARCH entries USING INDEX ${actorIndex.name}`,
    );
    expect(
      db
        .prepare(missingTrailingField.sql)
        .all(...sqliteParams(missingTrailingField.params)),
    ).toMatchObject([{ id: "m-missing-account" }]);

    const full = compileView(view({
      fields: ["id"],
      filter: {
        and: [
          { eq: { field: "userId", value: "u1" } },
          { eq: { field: "state", value: "active" } },
          { eq: { field: "accountId", value: "a1" } },
        ],
      },
    }), {}, schema);
    const fullPlan = planDetails(db, full).join("\n");
    expect(fullPlan).toContain("SEARCH entries USING INDEX");
    expect(fullPlan).toContain(`${userId}=?`);
    expect(fullPlan).toContain(`${state}=?`);
    expect(fullPlan).toContain(`${accountId}=?`);

    const ordered = compileView(view({
      fields: ["userId"],
      filter: {
        and: [
          { eq: { field: "accountId", value: "a1" } },
          { eq: { field: "state", value: "active" } },
        ],
      },
      orderBy: [{ field: "userId", direction: "asc" }],
      limit: 100,
    }), {}, schema);
    const orderedPlan = planDetails(db, ordered).join("\n");
    expect(orderedPlan).toContain(`SEARCH entries USING INDEX ${accountIndex.name}`);
    expect(orderedPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    const orderedRows = db.prepare(ordered.sql)
      .all(...sqliteParams(ordered.params)) as Array<{ userId: string }>;
    const users = orderedRows.map((row) => row.userId);
    expect(users).toEqual([...users].sort());

    const skippedLeftmost = compileView(view({
      fields: ["id"],
      filter: { eq: { field: "state", value: "active" } },
    }), {}, schema);
    const skippedPlan = planDetails(db, skippedLeftmost).join("\n");
    expect(skippedPlan).not.toContain(actorIndex.name);
    expect(skippedPlan).not.toContain(accountIndex.name);
  });

  it("keeps projection aliases, JSON fallback, native aliases, and Schema identity safe", () => {
    const compiled = compileView(view({
      fields: ["userId", "role", "createdAt"],
      filter: { eq: { field: "role", value: "owner" } },
      orderBy: [{ field: "userId", direction: "asc" }],
    }), {}, schema);

    expect(compiled.sql).toContain(`${schemaIndexedFieldSql(schema, "userId")} AS "userId"`);
    expect(compiled.sql).toContain(`json_extract(data, '$."role"') AS "role"`);
    expect(compiled.sql).toContain(`json_extract(data, '$."role"') = ?`);
    expect(compiled.sql).toContain("created_at AS createdAt");

    const mismatched = { ...schema, metadata: { name: "other-schema" } };
    expect(() => compileView(view({}), {}, mismatched)).toThrow(/cannot compile/i);

    // Defensive precedence: the grammar rejects reserved aliases, but a raw
    // object must still never make View.createdAt address JSON data.
    const invalidCollision = {
      ...schema,
      spec: {
        ...schema.spec,
        indexes: [["createdAt"]],
        schema: {
          ...schema.spec.schema,
          properties: {
            ...schema.spec.schema.properties,
            createdAt: { type: "integer" },
          },
        },
      },
    } as SchemaManifest;
    const native = compileView(view({
      fields: ["createdAt"],
      filter: { eq: { field: "createdAt", value: 1 } },
      orderBy: [{ field: "createdAt", direction: "desc" }],
    }), {}, invalidCollision);
    expect(native.sql).toContain("created_at AS createdAt");
    expect(native.sql).toContain("created_at = ?");
    expect(native.sql).toContain("ORDER BY created_at DESC");
  });

  it("qualifies public helper references for shared-table self joins", () => {
    const unqualified = schemaIndexedFieldSql(schema, "accountId");
    const qualified = schemaIndexedFieldSql(schema, "accountId", "m");
    expect(qualified).toMatch(/^"m"\.".+"$/);
    expect(() => db.prepare(
      `SELECT m.id FROM entries AS m JOIN entries AS a ON ${unqualified} = a.id`,
    ).all()).toThrow(/ambiguous column name/i);

    const row = db.prepare(
      `SELECT m.id AS memberId, a.id AS accountId
       FROM entries AS m JOIN entries AS a ON ${qualified} = a.id
       WHERE m.id = ?`,
    ).get("m101") as { memberId: string; accountId: string };
    expect(row.memberId).toBe("m101");
    expect(row.accountId).toBe("a1");
  });

  it("repository lookup mixes generated refs and JSON paths without bind drift", async () => {
    const executions: RecordedExecution[] = [];
    const repository = new DatabaseEntryRepository(
      createSqliteDriver(db, executions),
      new Map([[schema.metadata.name, schema]]),
    );

    await expect(repository.findByDataField({
      collection: schema.metadata.name,
      field: "userId",
      value: "u1",
    })).resolves.toMatchObject({ data: { userId: "u1" } });
    expect(executions.at(-1)).toMatchObject({
      params: [schema.metadata.name, "u1"],
    });
    expect(executions.at(-1)?.sql).toContain(schemaIndexedFieldSql(schema, "userId"));

    await expect(repository.findByDataField({
      collection: schema.metadata.name,
      field: "role",
      value: "owner",
    })).resolves.toMatchObject({ data: { role: "owner" } });
    expect(executions.at(-1)).toMatchObject({
      params: [schema.metadata.name, `$."role"`, "owner"],
    });
    expect(executions.at(-1)?.sql).toContain("json_extract(data, ?) = ?");

    await expect(repository.findByDataFields({
      collection: schema.metadata.name,
      status: "published",
      fields: { userId: "u1", role: "member" },
      excludeId: "not-this-row",
    })).resolves.toMatchObject({ data: { userId: "u1", role: "member" } });
    expect(executions.at(-1)).toMatchObject({
      params: [
        schema.metadata.name,
        "published",
        "u1",
        `$."role"`,
        "member",
        "not-this-row",
      ],
    });
    expect(executions.at(-1)?.sql).toContain(schemaIndexedFieldSql(schema, "userId"));
    expect(executions.at(-1)?.sql).toContain("json_extract(data, ?) = ?");
  });

  it("ExecuteViewUseCase resolves the View's Schema from its injected map", async () => {
    const executions: RecordedExecution[] = [];
    const useCase = new ExecuteViewUseCase(
      createSqliteDriver(db, executions),
      undefined,
      new Map([[schema.metadata.name, schema]]),
    );
    const result = await useCase.execute({
      view: view({
        fields: ["userId"],
        filter: { eq: { field: "userId", value: "u1" } },
      }),
    });

    expect(result.ok).toBe(true);
    expect(executions.at(-1)?.sql).toContain(schemaIndexedFieldSql(schema, "userId"));
  });

  it("removes a colliding alpha.59 constraint during a populated upgrade", async () => {
    const upgrade = new DatabaseSync(":memory:");
    try {
      createEntriesTable(upgrade);
      upgrade.exec(`
        INSERT INTO entries
          (id, collection, status, version, data, created_at, updated_at)
        VALUES
          ('1', 'members', 'published', 1, '{"a__b":"legacy","a":"current-a","b":"current-b"}', 1, 1);
        ALTER TABLE entries ADD COLUMN "members__a__b" TEXT
          GENERATED ALWAYS AS (
            CASE WHEN collection = 'members' THEN json_extract(data, '$.a__b') END
          ) VIRTUAL;
        CREATE UNIQUE INDEX "uq_members__a__b"
          ON entries("members__a__b")
          WHERE "members__a__b" IS NOT NULL;
        CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
        INSERT INTO _migrations (id, applied_at)
          VALUES ('schema-unique-index:uq_members__a__b', 1);
      `);
      const currentSchema = {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "Schema",
        metadata: { name: "members" },
        spec: {
          title: "Members",
          schema: {
            type: "object",
            properties: {
              a: { type: "string" },
              b: { type: "string" },
            },
          },
          uniqueIndexes: [["a", "b"]],
        },
      } as SchemaManifest;
      const ddl = buildDdl(currentSchema);
      for (const column of ddl.columns) upgrade.exec(column.sql);
      for (const index of ddl.indexes) upgrade.exec(index.sql);
      const migrations = schemaIndexMigrations([currentSchema]);
      const record = upgrade.prepare(
        `INSERT INTO _migrations (id, applied_at) VALUES (?, 2)`,
      );
      for (const migration of migrations) record.run(migration.id);

      await reconcileSchemaIndexes(
        createSqliteDriver(upgrade, []),
        migrations,
        [currentSchema],
      );

      const indexes = upgrade.prepare("PRAGMA index_list('entries')").all() as unknown as
        IndexListRow[];
      expect(indexes.map(({ name }) => name)).not.toContain("uq_members__a__b");
      expect(indexes.map(({ name }) => name)).toContain(ddl.indexes[0]?.name);
      expect(upgrade.prepare(
        `SELECT id FROM _migrations WHERE id = 'schema-unique-index:uq_members__a__b'`,
      ).get()).toBeUndefined();
    } finally {
      upgrade.close();
    }
  });
});
