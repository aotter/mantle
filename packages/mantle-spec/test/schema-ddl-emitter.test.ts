import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  buildDdl,
  schemaIndexedFieldSql,
} from "../src/domain/service/SchemaDdlEmitter.js";
import type { SchemaManifest } from "../src/domain/model/ManifestGrammar.js";

const baseManifest = (
  name: string,
  spec: Partial<SchemaManifest["spec"]> = {},
): SchemaManifest => ({
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name },
  spec: {
    title: name,
    schema: {
      type: "object",
      properties: { slug: { type: "string" } },
    },
    uniqueIndexes: [["slug"]],
    ...spec,
  },
});

describe("SchemaDdlEmitter", () => {
  it("emits deterministic v2 records and reuses affinity-correct columns", () => {
    const manifest = baseManifest("posts", {
      schema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          locale: { type: ["string", "null"] },
          rank: { type: "integer" },
          score: { type: "number", nullable: true },
          active: { type: "boolean" },
        },
      },
      uniqueIndexes: [["slug", "locale"]],
      indexes: [["slug", "rank"], ["score"], ["active"]],
    });

    const ddl = buildDdl(manifest);

    expect(ddl.columns).toHaveLength(5);
    expect(ddl.indexes).toHaveLength(4);
    expect(ddl.columns.map((column) => column.name)).toContain(
      "m2c_706f737473_736c7567_54455854",
    );
    expect(ddl.indexes[0]?.name).toBe(
      "m2u_706f737473_736c7567_54455854__6c6f63616c65_54455854",
    );
    expect(ddl.columns.find((column) => column.sql.includes("$.\"slug\""))?.sql)
      .toContain(" TEXT GENERATED");
    expect(ddl.columns.find((column) => column.sql.includes("$.\"rank\""))?.sql)
      .toContain(" INTEGER GENERATED");
    expect(ddl.columns.find((column) => column.sql.includes("$.\"score\""))?.sql)
      .toContain(" REAL GENERATED");
    expect(ddl.columns.find((column) => column.sql.includes("$.\"active\""))?.sql)
      .toContain(" INTEGER GENERATED");
    expect(ddl.indexes[0]?.sql).toMatch(/WHERE "[a-z0-9_]+" IS NOT NULL$/);
    expect(ddl.indexes[0]?.sql).not.toMatch(/ IS NOT NULL AND /);
    for (const name of [
      ...ddl.columns.map((column) => column.name),
      ...ddl.indexes.map((index) => index.name),
    ]) {
      expect(name).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("keeps literal top-level dot/case names collision-free", () => {
    const manifest = baseManifest("Posts.v2", {
      schema: {
        type: "object",
        properties: {
          "a.b": { type: "string" },
          a_b: { type: "string" },
          a__b: { type: "string" },
          Foo: { type: "string" },
          foo: { type: "string" },
        },
      },
      uniqueIndexes: [],
      indexes: [["a.b"], ["a_b"], ["a__b"], ["Foo"], ["foo"]],
    });

    const ddl = buildDdl(manifest);
    expect(new Set(ddl.columns.map((column) => column.name)).size).toBe(5);
    expect(new Set(ddl.indexes.map((index) => index.name)).size).toBe(5);
    expect(ddl.columns.some((column) => column.sql.includes(`$."a.b"`))).toBe(true);
  });

  it("exposes only quoted declared generated-column references", () => {
    const manifest = baseManifest("posts");
    const plain = schemaIndexedFieldSql(manifest, "slug");

    expect(plain).toBe('"m2c_706f737473_736c7567_54455854"');
    expect(schemaIndexedFieldSql(manifest, "slug", "entry")).toBe(
      '"entry"."m2c_706f737473_736c7567_54455854"',
    );
    expect(schemaIndexedFieldSql(manifest, "slug", 'e"vil')).toBe(
      '"e""vil"."m2c_706f737473_736c7567_54455854"',
    );
    expect(schemaIndexedFieldSql(manifest, "title")).toBeNull();
  });

  it("covers reverse relationship ordering with an explicit single-field index", () => {
    const manifest = baseManifest("comments", {
      schema: {
        type: "object",
        properties: {
          postId: { type: "string", "x-mantle-ref": "posts" },
        },
      },
      uniqueIndexes: [],
      indexes: [["postId"]],
    });

    const [index] = buildDdl(manifest).indexes;

    expect(index?.name).toMatch(/^m2r_/);
    expect(index?.sql).toContain(', "updated_at" DESC, "id" DESC)');
  });

  it("fails closed on unsafe or invalid declarations", () => {
    expect(() => buildDdl(baseManifest("1posts"))).toThrow(/safe index identifier/);
    expect(() =>
      buildDdl(baseManifest("posts", {
        schema: {
          type: "object",
          properties: { _slug: { type: "string" } },
        },
        uniqueIndexes: [["_slug"]],
      })),
    ).toThrow(/safe index identifier/);
    expect(() =>
      buildDdl(baseManifest("posts", { uniqueIndexes: [[]] })),
    ).toThrow(/must not be empty/);
  });

});

describe("SchemaDdlEmitter — real SQLite", () => {
  it("upgrades a populated alpha.59 table and exposes v2 PRAGMA structure", () => {
    const db = new DatabaseSync(":memory:");
    try {
      createEntries(db);
      db.exec(`
        INSERT INTO entries (id, collection, data) VALUES
          ('1', 'account-members', '{"accountId":"a1","email":"one@example.com","userId":"u1","state":"active"}'),
          ('2', 'account-members', '{"accountId":"a1","email":"two@example.com","userId":"u2","state":"active"}');
        ALTER TABLE entries ADD COLUMN "account-members__accountId" TEXT
          GENERATED ALWAYS AS (
            CASE WHEN collection = 'account-members' THEN json_extract(data, '$.accountId') END
          ) VIRTUAL;
        ALTER TABLE entries ADD COLUMN "account-members__email" TEXT
          GENERATED ALWAYS AS (
            CASE WHEN collection = 'account-members' THEN json_extract(data, '$.email') END
          ) VIRTUAL;
        CREATE UNIQUE INDEX "uq_account-members__accountId__email"
          ON entries("account-members__accountId", "account-members__email")
          WHERE "account-members__accountId" IS NOT NULL
            AND "account-members__email" IS NOT NULL;
      `);
      const manifest = accountMembersManifest();
      const ddl = buildDdl(manifest);

      applyDdl(db, ddl);

      const tableInfo = db.prepare("PRAGMA table_xinfo(entries)").all() as Array<{
        name: string;
        type: string;
        hidden: number;
      }>;
      for (const column of ddl.columns) {
        expect(tableInfo.find((info) => info.name === column.name)?.hidden).toBe(2);
      }
      expect(tableInfo.find((info) => info.name === unquote(
        schemaIndexedFieldSql(manifest, "score")!,
      ))?.type).toBe("REAL");
      expect(tableInfo.find((info) => info.name === unquote(
        schemaIndexedFieldSql(manifest, "active")!,
      ))?.type).toBe("INTEGER");

      const indexList = db.prepare("PRAGMA index_list(entries)").all() as Array<{
        name: string;
        unique: number;
        partial: number;
      }>;
      const declarations = [
        ...(manifest.spec.uniqueIndexes ?? []),
        ...(manifest.spec.indexes ?? []),
      ];
      ddl.indexes.forEach((index, declarationIndex) => {
        expect(indexList.find((info) => info.name === index.name)).toMatchObject({
          unique: index.sql.startsWith("CREATE UNIQUE INDEX") ? 1 : 0,
          partial: 1,
        });
        const keyColumns = (db.prepare(`PRAGMA index_xinfo("${index.name}")`).all() as Array<{
          name: string | null;
          key: number;
        }>).filter((column) => column.key === 1).map((column) => column.name);
        expect(keyColumns).toEqual(
          declarations[declarationIndex]?.map((field) =>
            unquote(schemaIndexedFieldSql(manifest, field)!)),
        );
      });
      expect(indexList.some((index) => index.name === "uq_account-members__accountId__email"))
        .toBe(true);
    } finally {
      db.close();
    }
  });

  it("enforces unique indexes while retaining SQLite NULL semantics", () => {
    const db = new DatabaseSync(":memory:");
    try {
      createEntries(db);
      const manifest = accountMembersManifest();
      applyDdl(db, buildDdl(manifest));
      const insert = db.prepare("INSERT INTO entries (id, collection, data) VALUES (?, ?, ?)");
      insert.run("1", "account-members", JSON.stringify({ accountId: "a1", email: "a@x" }));
      expect(() => insert.run(
        "2", "account-members", JSON.stringify({ accountId: "a1", email: "a@x" }),
      )).toThrow(/UNIQUE constraint failed/);
      insert.run("3", "account-members", JSON.stringify({ accountId: "a1", email: null }));
      insert.run("4", "account-members", JSON.stringify({ accountId: "a1", email: null }));
    } finally {
      db.close();
    }
  });

  it("enforces unique indexes across concurrent SQLite connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mantle-index-race-"));
    const file = join(directory, "entries.sqlite");
    const setup = new DatabaseSync(file);
    try {
      createEntries(setup);
      applyDdl(setup, buildDdl(accountMembersManifest()));
      setup.exec("PRAGMA journal_mode = WAL");
      setup.close();

      const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const workers = ["race-1", "race-2"].map((id) =>
        new Worker(CONCURRENT_INSERT_WORKER, {
          eval: true,
          workerData: { file, gate, id },
        }));
      const results = workers.map(workerResult);
      await waitUntilReady(new Int32Array(gate), workers.length);
      Atomics.store(new Int32Array(gate), 1, 1);
      Atomics.notify(new Int32Array(gate), 1, workers.length);

      const outcomes = await Promise.all(results);
      expect(outcomes.filter((outcome) => outcome === "inserted")).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome !== "inserted"))
        .toMatch(/UNIQUE constraint failed/);
    } finally {
      if (setup.isOpen) setup.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const CONCURRENT_INSERT_WORKER = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const { DatabaseSync } = require("node:sqlite");
  const gate = new Int32Array(workerData.gate);
  const db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA busy_timeout = 5000");
  Atomics.add(gate, 0, 1);
  Atomics.notify(gate, 0);
  Atomics.wait(gate, 1, 0);
  let outcome;
  try {
    db.prepare("INSERT INTO entries (id, collection, data) VALUES (?, ?, ?)").run(
      workerData.id,
      "account-members",
      JSON.stringify({ accountId: "a1", email: "same@example.com" }),
    );
    outcome = "inserted";
  } catch (error) {
    outcome = String(error);
  }
  db.close();
  parentPort.postMessage(outcome);
`;

function workerResult(worker: Worker): Promise<string> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

async function waitUntilReady(gate: Int32Array, count: number): Promise<void> {
  for (let attempts = 0; Atomics.load(gate, 0) < count; attempts += 1) {
    if (attempts === 1_000) throw new Error("concurrent SQLite workers did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function accountMembersManifest(): SchemaManifest {
  return baseManifest("account-members", {
    schema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        state: { type: "string" },
        accountId: { type: "string" },
        email: { type: ["string", "null"] },
        score: { type: "number" },
        active: { type: "boolean" },
      },
    },
    indexes: [
      ["userId", "state", "accountId"],
      ["accountId", "state", "userId"],
      ["score"],
      ["active"],
    ],
    uniqueIndexes: [["accountId", "email"]],
  });
}

function createEntries(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      data TEXT NOT NULL
    );
  `);
}

function applyDdl(db: DatabaseSync, ddl: ReturnType<typeof buildDdl>): void {
  for (const column of ddl.columns) db.exec(column.sql);
  for (const index of ddl.indexes) db.exec(index.sql);
}

function unquote(identifier: string): string {
  return identifier.slice(1, -1).replace(/""/g, '"');
}
