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
import { compileView } from "../src/infrastructure/storage/SqliteViewCompiler.js";
import {
  compileLogicalView,
  type RuntimePlan,
  type RuntimeViewPlan,
} from "../src/domain/service/RuntimePlanCompiler.js";
import {
  reconcileSchemaIndexes,
  schemaIndexMigrations,
  CANONICAL_MIGRATIONS,
} from "../src/infrastructure/boot/index.js";
import { joinParentForList } from "../src/domain/service/io/JoinedEntryReader.js";
import { DatabaseEntryRepository } from "../src/infrastructure/persistence/DatabaseEntryRepository.js";
import { ExecuteViewUseCase } from "../src/usecase/view/ExecuteViewUseCase.js";
import { SqliteViewQueryExecutor } from "../src/infrastructure/storage/SqliteMantleStorageAdapter.js";
import { readEntryBySlug } from "../src/index.js";

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
    spec: { surface: "public", from: schema.metadata.name, ...spec },
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

function executionPlanDetails(
  db: DatabaseSync,
  execution: RecordedExecution,
): readonly string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${execution.sql}`)
    .all(...sqliteParams(execution.params)) as unknown as QueryPlanRow[])
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

describe("canonical maintenance indexes", () => {
  it("searches the pending-upload expiry index during cleanup", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of CANONICAL_MIGRATIONS) db.exec(migration.sql);
      const details = (db.prepare(
        "EXPLAIN QUERY PLAN DELETE FROM pending_media_uploads WHERE expires_at <= ?",
      ).all(1) as unknown as QueryPlanRow[]).map((row) => row.detail);

      expect(details).toContainEqual(
        expect.stringMatching(
          /SEARCH pending_media_uploads USING INDEX pending_media_uploads_expires_at/,
        ),
      );
    } finally {
      db.close();
    }
  });
});

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

  it("keeps a ctx.user-bound View on the declared identity index", () => {
    const actorIndex = findIndex(db, ["userId", "state", "accountId"], false);
    const compiled = compileView(view({
      fields: ["userId", "state"],
      requires: { auth: { all: ["ctx.user"] } },
      filter: {
        and: [
          { eq: { field: "userId", value: { "$ctx.user": "id" } } },
          { eq: { field: "state", value: "active" } },
        ],
      },
    }), { ctxUserId: "u1" }, schema);
    const plan = planDetails(db, compiled).join("\n");
    expect(plan).toContain(`SEARCH entries USING INDEX ${actorIndex.name}`);
    expect(plan).not.toContain("SCAN entries");
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
      field: "state",
      value: "active",
    })).resolves.toMatchObject({ data: { state: "active" } });
    expect(executions.at(-1)?.sql).not.toContain(
      schemaIndexedFieldSql(schema, "state"),
    );
    expect(executions.at(-1)?.sql).toContain("json_extract(data, ?) = ?");

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

  it("repository sorts an indexed field with reversible keyset cursors", async () => {
    const executions: RecordedExecution[] = [];
    const repository = new DatabaseEntryRepository(
      createSqliteDriver(db, executions),
      new Map([[schema.metadata.name, schema]]),
    );
    const sort = { field: "userId", direction: "asc" } as const;
    const first = await repository.list({
      collection: schema.metadata.name,
      limit: 3,
      sort,
    });
    expect(first.rows).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();
    expect(executions.at(-1)?.sql).toContain(
      `ORDER BY ${schemaIndexedFieldSql(schema, "userId")} ASC, id ASC`,
    );

    const second = await repository.list({
      collection: schema.metadata.name,
      limit: 3,
      cursor: first.nextCursor,
      sort,
    });
    expect(second.previousCursor).toBeDefined();
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(6);

    const back = await repository.list({
      collection: schema.metadata.name,
      limit: 3,
      cursor: second.previousCursor,
      cursorDirection: "backward",
      sort,
    });
    expect(back.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
  });

  it("repository serializes boolean sort cursors as SQLite integers", async () => {
    const booleanDb = new DatabaseSync(":memory:");
    try {
      createEntriesTable(booleanDb);
      const booleanSchema = {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "Schema",
        metadata: { name: "flags" },
        spec: {
          title: "Flags",
          schema: {
            type: "object",
            properties: { active: { type: "boolean" } },
            required: ["active"],
          },
          indexes: [["active"]],
        },
      } as SchemaManifest;
      for (const column of buildDdl(booleanSchema).columns) booleanDb.exec(column.sql);
      for (const index of buildDdl(booleanSchema).indexes) booleanDb.exec(index.sql);
      const insert = booleanDb.prepare(
        `INSERT INTO entries
         (id, collection, status, version, data, created_at, updated_at, author_id)
         VALUES (?, 'flags', 'published', 1, ?, 1, 1, NULL)`,
      );
      insert.run("f1", JSON.stringify({ active: false }));
      insert.run("f2", JSON.stringify({ active: true }));
      insert.run("f3", JSON.stringify({ active: true }));
      const repository = new DatabaseEntryRepository(
        createSqliteDriver(booleanDb, []),
        new Map([[booleanSchema.metadata.name, booleanSchema]]),
      );
      const sort = { field: "active", direction: "asc" } as const;
      const first = await repository.list({ collection: "flags", limit: 2, sort });
      expect(first.rows.map((row) => row.data.active)).toEqual([false, true]);
      expect(first.nextCursor).toBeDefined();
      const second = await repository.list({
        collection: "flags",
        limit: 2,
        cursor: first.nextCursor,
        sort,
      });
      expect(second.rows.map((row) => row.data.active)).toEqual([true]);
    } finally {
      booleanDb.close();
    }
  });

  it("searches only id and explicitly resolved string fields", async () => {
    const executions: RecordedExecution[] = [];
    const repository = new DatabaseEntryRepository(
      createSqliteDriver(db, executions),
      new Map([[schema.metadata.name, schema]]),
    );

    const email = await repository.list({
      collection: schema.metadata.name,
      search: "member4999",
      searchFields: ["email"],
    });
    expect(email.rows.map((row) => row.id)).toEqual(["m4999"]);

    const undeclared = await repository.list({
      collection: schema.metadata.name,
      search: "disabled",
      searchFields: ["email"],
    });
    expect(undeclared.rows).toEqual([]);
    expect(executions.at(-1)?.sql).not.toContain("json_tree");
  });

  it("ExecuteViewUseCase resolves the View's Schema from its injected map", async () => {
    const executions: RecordedExecution[] = [];
    const manifest = view({
      fields: ["userId"],
      filter: { eq: { field: "userId", value: "u1" } },
    });
    const planned: RuntimeViewPlan = {
      name: manifest.metadata.name,
      manifest,
      query: compileLogicalView(manifest),
    };
    const plan = {
      views: { [planned.name]: planned },
      schemas: {
        [schema.metadata.name]: { name: schema.metadata.name, manifest: schema },
      },
    } as unknown as RuntimePlan;
    const useCase = new ExecuteViewUseCase(
      new SqliteViewQueryExecutor(createSqliteDriver(db, executions), plan),
      undefined,
      plan.views,
    );
    const result = await useCase.execute({
      view: manifest,
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

function entryReadSchema(
  name: string,
  indexes: readonly (readonly string[])[] = [],
): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name },
    spec: {
      title: name,
      localized: true,
      lifecycle: "publishing",
      schema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          locale: { type: ["string", "null"] },
          tenantId: { type: "string" },
          marker: { type: "string" },
        },
      },
      indexes: indexes.map((fields) => [...fields]),
    },
  };
}

function translationSchema(name: string, parent: string): SchemaManifest {
  const base = entryReadSchema(name);
  return {
    ...base,
    spec: {
      ...base.spec,
      translates: { parent, on: "slug" },
    },
  };
}

describe("EntryReader against crowded real SQLite", () => {
  const slugLocale = entryReadSchema("reads-slug-locale", [["slug", "locale"]]);
  const localeSlug = entryReadSchema("reads-locale-slug", [["locale", "slug"]]);
  const slugOnly = entryReadSchema("reads-slug-only", [["slug"]]);
  const tenantSlug = entryReadSchema("reads-tenant-slug", [["tenantId", "slug"]]);
  const noIndex = entryReadSchema("reads-no-index");
  const triState = entryReadSchema("reads-tri-state");
  const batchParent = entryReadSchema("reads-batch-parent");
  const batchTranslation = translationSchema("reads-batch-translation", batchParent.metadata.name);
  const schemas = [
    slugLocale,
    localeSlug,
    slugOnly,
    tenantSlug,
    noIndex,
    triState,
    batchParent,
    batchTranslation,
  ] as const;
  const schemasByName = new Map(schemas.map((item) => [item.metadata.name, item]));
  const executions: RecordedExecution[] = [];
  let db: DatabaseSync;
  let driver: DatabaseDriver;
  let reader: DatabaseEntryRepository;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    for (const migration of CANONICAL_MIGRATIONS) db.exec(migration.sql);
    const insert = db.prepare(
      `INSERT INTO entries
       (id, collection, status, version, data, author_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    );

    for (const current of [slugLocale, localeSlug, slugOnly, tenantSlug, noIndex]) {
      for (let index = 0; index < 1_200; index += 1) {
        insert.run(
          `${current.metadata.name}-${index}`,
          current.metadata.name,
          index % 5 === 0 ? "published" : "draft",
          JSON.stringify({
            slug: `noise-${index}`,
            locale: index % 2 === 0 ? "en" : "zh-TW",
            tenantId: `tenant-${index % 20}`,
            marker: "noise",
          }),
          null,
          index,
          index,
        );
      }
      insert.run(
        `${current.metadata.name}-needle`,
        current.metadata.name,
        "published",
        JSON.stringify({
          slug: "needle",
          locale: "en",
          tenantId: "tenant-target",
          marker: current.metadata.name,
        }),
        "private-author",
        20_000,
        20_000,
      );
    }

    insert.run(
      "tri-en",
      triState.metadata.name,
      "published",
      JSON.stringify({ slug: "tri", locale: "en", marker: "en" }),
      "private-author",
      1,
      10,
    );
    insert.run(
      "tri-missing",
      triState.metadata.name,
      "published",
      JSON.stringify({ slug: "tri", marker: "missing" }),
      null,
      1,
      20,
    );
    insert.run(
      "tri-null",
      triState.metadata.name,
      "published",
      JSON.stringify({ slug: "tri", locale: null, marker: "null" }),
      null,
      1,
      30,
    );

    for (let index = 0; index < 191; index += 1) {
      insert.run(
        `batch-parent-${index}`,
        batchParent.metadata.name,
        "published",
        JSON.stringify({ slug: `parent-${index}`, marker: `parent-marker-${index}` }),
        null,
        index,
        index,
      );
    }

    for (const current of schemas) {
      const ddl = buildDdl(current);
      for (const column of ddl.columns) db.exec(column.sql);
      for (const index of ddl.indexes) db.exec(index.sql);
    }
    db.exec("ANALYZE");
    driver = createSqliteDriver(db, executions);
    reader = new DatabaseEntryRepository(driver, schemasByName);
  });

  afterAll(() => db.close());

  it("uses only planner-compatible declared prefixes for slug and locale", async () => {
    for (const current of [slugLocale, localeSlug]) {
      executions.length = 0;
      const found = await reader.readBySlug({
        collection: current.metadata.name,
        slug: "needle",
        locale: "en",
        status: "published",
      });
      expect(found?.id).toBe(`${current.metadata.name}-needle`);
      expect(Object.hasOwn(found ?? {}, "authorId")).toBe(false);

      const execution = executions.at(-1)!;
      const indexName = buildDdl(current).indexes[0]!.name;
      const plan = executionPlanDetails(db, execution).join("\n");
      expect(plan).toContain(`SEARCH entries USING INDEX ${indexName}`);
      expect(plan).not.toContain("SCAN entries");
    }

    executions.length = 0;
    await expect(reader.readBySlug({
      collection: slugOnly.metadata.name,
      slug: "needle",
      locale: "en",
      status: "published",
    })).resolves.toMatchObject({ id: `${slugOnly.metadata.name}-needle` });
    const slugOnlyExecution = executions.at(-1)!;
    expect(slugOnlyExecution.sql).toContain(schemaIndexedFieldSql(slugOnly, "slug"));
    expect(slugOnlyExecution.sql).toContain("json_extract(data, ?) = ?");
    expect(executionPlanDetails(db, slugOnlyExecution).join("\n")).toContain(
      `SEARCH entries USING INDEX ${buildDdl(slugOnly).indexes[0]!.name}`,
    );

    for (const current of [tenantSlug, noIndex]) {
      executions.length = 0;
      await expect(reader.readBySlug({
        collection: current.metadata.name,
        slug: "needle",
        locale: "en",
        status: "published",
      })).resolves.toMatchObject({ id: `${current.metadata.name}-needle` });
      const execution = executions.at(-1)!;
      expect(execution.sql).toContain("json_extract(data, ?) = ?");
      for (const index of buildDdl(current).indexes) {
        expect(executionPlanDetails(db, execution).join("\n")).not.toContain(index.name);
      }
    }
  });

  it("preserves locale string, null, and omitted semantics and the public helper", async () => {
    await expect(reader.readBySlug({
      collection: triState.metadata.name,
      slug: "tri",
      locale: "en",
      status: "published",
    })).resolves.toMatchObject({ id: "tri-en", locale: "en" });

    await expect(reader.readBySlug({
      collection: triState.metadata.name,
      slug: "tri",
      status: "published",
    })).resolves.toMatchObject({ id: "tri-null" });

    executions.length = 0;
    const nullLocale = await reader.readBySlug({
      collection: triState.metadata.name,
      slug: "tri",
      locale: null,
      status: "published",
    });
    expect(nullLocale).toMatchObject({ id: "tri-null", data: { locale: null } });
    expect(executions.at(-1)?.sql).toContain("IS NULL");
    expect(executions.at(-1)?.sql).not.toContain("= NULL");

    const nullLocaleRows = await reader.readPublished({
      collection: triState.metadata.name,
      locale: null,
    });
    expect(nullLocaleRows.map((entry) => entry.id)).toEqual([
      "tri-null",
      "tri-missing",
    ]);

    executions.length = 0;
    const publicDb: DatabaseDriver = driver;
    const compatible = await readEntryBySlug(publicDb, {
      collection: slugLocale.metadata.name,
      slug: "needle",
      locale: "en",
      status: "published",
    });
    expect(compatible?.id).toBe(`${slugLocale.metadata.name}-needle`);
    expect(Object.hasOwn(compatible ?? {}, "authorId")).toBe(false);
    expect(executions.at(-1)?.sql).toContain("json_extract(data, ?) = ?");
  });

  it("keeps published list, sitemap, and llms reads on measured system indexes", async () => {
    const cases = [
      {
        args: { collection: slugLocale.metadata.name, locale: "en" },
        index: "entries_published_collection_locale_updated",
      },
      {
        args: { collection: slugLocale.metadata.name },
        index: "entries_by_collection_status_updated_id",
      },
      {
        args: { locale: "en" },
        index: "entries_published_locale_updated",
      },
      {
        args: {},
        index: "entries_published_updated",
        indexedScan: true,
      },
    ] as const;

    for (const current of cases) {
      executions.length = 0;
      await reader.readPublished(current.args);
      const plan = executionPlanDetails(db, executions.at(-1)!).join("\n");
      expect(plan).toContain(`USING INDEX ${current.index}`);
      if ("indexedScan" in current) {
        expect(plan).toContain(`SCAN entries USING INDEX ${current.index}`);
      } else {
        expect(plan).not.toContain("SCAN entries");
      }
      expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    }
  });

  it("chunks translation-parent reads below D1's 100-bind limit without N+1", async () => {
    const values = Array.from({ length: 191 }, (_, index) => `parent-${index}`);
    const translations = values.map((slug, index) => ({
      id: `translation-${index}`,
      collection: batchTranslation.metadata.name,
      locale: "en",
      status: "published" as const,
      version: 1,
      data: { slug, locale: "en", marker: `translation-marker-${index}` },
      createdAt: index,
      updatedAt: index,
    }));

    executions.length = 0;
    const joined = await joinParentForList(reader, schemasByName, translations, {
      parentStatus: "published",
    });
    expect(joined).toHaveLength(values.length);
    expect(joined[0]?.data).toMatchObject({
      slug: "parent-0",
      marker: "translation-marker-0",
    });
    const entryReads = executions.filter((execution) => execution.sql.includes("FROM entries"));
    expect(entryReads).toHaveLength(3);
    expect(entryReads.map((execution) => execution.params.length)).toEqual([99, 99, 5]);
    expect(Math.max(...entryReads.map((execution) => execution.params.length))).toBeLessThanOrEqual(100);
    expect(entryReads[0]?.params.slice(2, 97)).toEqual(values.slice(0, 95));
    expect(entryReads[1]?.params.slice(2, 97)).toEqual(values.slice(95, 190));
  });
});
