import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_CODES,
  PG_GRAMMAR,
  compileSql,
  type SqlContext,
  type SqlDialect,
  type SqlDiagnosticCode,
  type SqlNode,
} from "../../src/spec/index.js";
import { parsePgSql } from "../../src/spec/infrastructure/sql/PgQueryParser.js";
import { validateIr } from "../../src/d1/validator.js";

const SQL_DIAGNOSTIC_CODES = DIAGNOSTIC_CODES.filter((c): c is SqlDiagnosticCode => c.startsWith("SQL_"));

const schemas: SqlContext["schemas"] = {
  items: { scope: "owner", ttl: "expires_at", fields: { name: "text", cat: "text", stock: "integer", tags: "json", note: "text" } },
  requisitions: { scope: "owner", fields: { item_id: "text", qty: "integer", state: "text" } },
  orders: { scope: "owner", fields: { item_id: "text", qty: "integer", total: "numeric(12,2)" } },
  settings: { scope: "owner", fields: { key: "text", value: "text" } },
  posts: { publishing: true, ttl: "expires_at", fields: { title: "text", body: "text" } },
  places: { scope: "owner", ttl: "expires_at", fields: { name: "text", loc: "geo" } },
  events: { scope: "owner", fields: { title: "text", at: "timestamptz", day: "date", amount: "numeric(12,2)", qty: "integer" } },
};

type Kind = SqlContext["kind"];
type Refusal = [sql: string, code: SqlDiagnosticCode, token?: string, msg?: RegExp];
const ctxOf = (kind: Kind, inputs: Record<string, string> = {}): SqlContext => ({ schemas, inputs, kind });
const kindOf = (sql: string): Kind => (/^\s*SELECT/i.test(sql) ? "view" : "procedure");

// ponytail: one or two refusals per code plus the code-review regressions; the full dialect corpus lives in next/spike.
const REFUSED: Refusal[] = [
  ["SELECT id FROM items OFFSET 2", "SQL_UNSUPPORTED", "OFFSET", /limitOffset/],
  ["SELECT id FROM items WHERE id = $1", "SQL_UNSUPPORTED", "$1", /ParamRef/],
  ["CREATE TABLE t (a int)", "SQL_UNSUPPORTED", undefined, /CreateStmt/],
  ["SELECT sqlite_version()", "SQL_FUNCTION", "sqlite_version"],
  ["SELECT id FROM posts p WHERE search(p, 'q')", "SQL_FUNCTION", "search", /search is not on the allowlist/], // ADR-0035: only mantle.search is Mantle's
  ["SELECT id FROM items WHERE name = like_escape('a', '!')", "SQL_FUNCTION", undefined, /ESCAPE of a LIKE/],
  ["SELECT id FROM _mantle_tz", "SQL_RELATION", "_mantle_tz"],
  ["SELECT id FROM items WHERE owner = 'o2'", "SQL_COLUMN", "owner", /scope column/],
  ['SELECT id FROM items WHERE "Owner" = \'o2\'', "SQL_COLUMN", undefined, /scope column/], // code review: quoting keeps case, SQLite ignores it
  ["SELECT nope FROM items", "SQL_COLUMN", "nope", /not a declared field/],
  ['UPDATE items SET "OWNER" = \'o2\' WHERE id = \'a\'', "SQL_WRITE", undefined, /filled by Mantle/],
  ["INSERT INTO orders (id, item_id) VALUES ('x', 'a')", "SQL_WRITE", "id", /generates its ids/],
  ["SELECT id FROM items LIMIT 2", "SQL_SHAPE", "2", /LIMIT needs an ORDER BY/],
  ["INSERT INTO orders (item_id) VALUES ('a'), ('b')", "SQL_SHAPE", undefined, /one row/],
  ["SELECT CAST(stock AS int) FROM items", "SQL_TYPE", "CAST", /Write round\(x\)/],
  ["SELECT interval '1 ms'", "SQL_TYPE", undefined, /not supported/],
  ["SELEC id FROM items", "SQL_SYNTAX", "SELEC"],
];

describe("the shared front end (ADR-0035 decision 4)", () => {
  // a dialect that accepts everything: whatever is still refused, the front end refused
  const anything: SqlDialect = { name: "test/anything", version: "0", accepts: () => undefined };
  const refused: Refusal[] = [
    ["CREATE TABLE t (a int)", "SQL_UNSUPPORTED", undefined, /CreateStmt/],
    ["SET search_path = x", "SQL_UNSUPPORTED", undefined, /VariableSetStmt/],
    ["BEGIN", "SQL_UNSUPPORTED", undefined, /TransactionStmt/],
    ["COPY items TO STDOUT", "SQL_UNSUPPORTED", undefined, /CopyStmt/],
    ["DO $$ BEGIN END $$", "SQL_UNSUPPORTED", undefined, /DoStmt/],
    ["SELECT set_config('mantle.uid', 'o2', false)", "SQL_FUNCTION", "set_config"],
    ["SELECT current_setting(input.k)", "SQL_FUNCTION", "current_setting"],
    ["SELECT pg_advisory_lock(1)", "SQL_FUNCTION", "pg_advisory_lock"],
    ["SELECT id FROM _mantle_tz", "SQL_RELATION", "_mantle_tz"],
    ['SELECT (SELECT email FROM "user" LIMIT 1) AS e FROM items', "SQL_RELATION", '"user"'],
    ["SELECT id FROM public.items", "SQL_RELATION", "public.items", /schema-qualified/],
    ["INSERT INTO _mantle_boot (id) VALUES ('x')", "SQL_RELATION", "_mantle_boot"],
    ['DELETE FROM "user" WHERE id = \'x\'', "SQL_RELATION", '"user"'],
    ["SELECT id FROM items WHERE name = input.nope", "SQL_COLUMN", "input.nope"],
    ["SELECT mantle.nope(items) FROM items", "SQL_FUNCTION", "mantle.nope"],
    ["SELECT auth.email()", "SQL_FUNCTION", "auth.email"],
    ["WITH gone AS (DELETE FROM items RETURNING id) SELECT id FROM gone", "SQL_SHAPE", undefined, /reads only/],
    // review: spellings that must not slip past, and SQL text run by a function
    ["SELECT postgres.pg_catalog.set_config('mantle.uid', 'o2', false)", "SQL_FUNCTION", undefined, /set_config/],
    ["SELECT set_config('MANTLE.uid', 'o2', false)", "SQL_FUNCTION", "set_config"],
    ["SELECT db.mantle.evil(1)", "SQL_FUNCTION", undefined, /not one of Mantle's functions/],
    ["SELECT query_to_xml('select * from users', true, false, '')", "SQL_FUNCTION", "query_to_xml"],
    ["SELECT * FROM ts_stat('select v from users')", "SQL_FUNCTION", "ts_stat"],
    ["SELECT nextval('s')", "SQL_FUNCTION", "nextval"],
    ["SELECT id INTO t FROM items", "SQL_UNSUPPORTED", undefined, /INTO/],
    ["SELECT a.id FROM (WITH users AS (SELECT id FROM items) SELECT id FROM users) a, users", "SQL_RELATION", undefined, /users is not a declared Schema/],
    ["WITH users AS (SELECT id FROM users) SELECT id FROM users", "SQL_RELATION", undefined, /users is not a declared Schema/],
    ['SELECT id FROM "Items"', "SQL_RELATION", '"Items"'],
  ];
  it("refuses what no dialect may run, with a position, whatever the dialect accepts", async () => {
    for (const [sql, code, token, msg] of refused) {
      const res = await compileSql(sql, ctxOf(/^\s*(SELECT|WITH)/i.test(sql) ? "view" : "procedure"), anything);
      if (res.ok) throw new Error(`accepted: ${sql}`);
      expect(res.diagnostic, sql).toMatchObject({ code, ...(token ? { token } : {}) });
      if (msg) expect(res.diagnostic.message, sql).toMatch(msg);
    }
  });
  it("leaves the rest to the dialect: a CTE of the statement, a setting outside mantle.*, MERGE", async () => {
    for (const sql of ["WITH x AS (SELECT id FROM items) SELECT id FROM x", "WITH RECURSIVE x AS (SELECT id FROM items UNION ALL SELECT id FROM x) SELECT id FROM x", "SELECT current_setting('timezone')", "MERGE INTO items USING orders o ON items.id = o.item_id WHEN MATCHED THEN DELETE"])
      expect(await compileSql(sql, ctxOf(/^\s*(SELECT|WITH)/i.test(sql) ? "view" : "procedure"), anything), sql).toMatchObject({ ok: true });
  });
});

describe("compileSql", () => {
  it("refuses outside the subset with a code and a position; the runtime validator refuses the same IR", async () => {
    expect(new Set(REFUSED.map((r) => r[1]))).toEqual(new Set(SQL_DIAGNOSTIC_CODES));
    for (const [sql, code, token, msg] of REFUSED) {
      const res = await compileSql(sql, ctxOf(kindOf(sql)));
      if (res.ok) throw new Error(`accepted: ${sql}`);
      expect(res.diagnostic, sql).toMatchObject({ code, ...(token ? { token } : {}) });
      if (token) expect(res.diagnostic.line, sql).toBeGreaterThanOrEqual(1);
      if (msg) expect(res.diagnostic.message, sql).toMatch(msg);
      if (code !== "SQL_SYNTAX") expect(validateIr({ grammar: PG_GRAMMAR, stmts: (await parsePgSql(sql)).stmts }, ctxOf(kindOf(sql)))[0]?.code, sql).toBe(code);
    }
  });

  it("a public View must tie a non-publishing Schema to a publishing one in a JOIN ... ON (decision 8)", async () => {
    const pub = (sql: string) => compileSql(sql, { ...ctxOf("view"), public: true });
    const j = (on: string) => `SELECT p.id FROM posts p JOIN settings s ON ${on}`;
    expect(await pub(j("s.key = p.title"))).toMatchObject({ ok: true });
    expect(await pub(j("s.key = 'a'"))).toMatchObject({ ok: false, diagnostic: { code: "SQL_RELATION", message: /published/ } });
    expect(await pub("SELECT id FROM settings ORDER BY id")).toMatchObject({ ok: true });
  });

  it("points at the right line, column and token (multi-line, after Chinese text, past a quoted keyword)", async () => {
    const at = async (sql: string) => {
      const r = await compileSql(sql, ctxOf("view"));
      return r.ok ? undefined : [r.diagnostic.line, r.diagnostic.column, r.diagnostic.token];
    };
    expect(await at("SELECT id\nFROM items\n  WHERE id = 1\nOFFSET 3")).toEqual([4, 1, "OFFSET"]);
    expect(await at("SELECT 台北 FORM items")).toEqual([1, 16, "items"]);
    expect(await at("SELECT id FROM items WHERE name = 'offset' ORDER BY id OFFSET 2")).toEqual([1, 56, "OFFSET"]);
  });

  it("accepts the spike corpus; the IR has no locations, every relation is tagged, and the runtime validator agrees", async () => {
    const corpus = JSON.parse(readFileSync(new URL("./fixtures/sql-corpus.json", import.meta.url), "utf8")) as Array<{ kind: Kind; sql: string; inputs?: Record<string, string> }>;
    const extra = [
      "SELECT CAST('5' AS int), CAST(7 AS int), round(stock) FROM items",
      "SELECT id FROM events WHERE at > now() - interval '36 hours' ORDER BY id",
      "SELECT id FROM items WHERE name LIKE 'a!%' ESCAPE '!' ORDER BY id",
      "SELECT p.id FROM posts p WHERE mantle.search(p, 'q') ORDER BY mantle.search_rank(p) LIMIT 5",
    ].map((sql) => ({ kind: "view" as Kind, sql }));
    for (const c of [...corpus, ...extra]) {
      const res = await compileSql(c.sql, ctxOf(c.kind, c.inputs));
      if (!res.ok) throw new Error(`refused ${c.sql}: ${JSON.stringify(res.diagnostic)}`);
      expect(res.plan.grammar).toBe(180004);
      expect(validateIr(res.plan, ctxOf(c.kind, c.inputs)), c.sql).toEqual([]);
      const json = JSON.stringify(res.plan);
      expect(json).not.toContain('"location"');
      expect(json.match(/"relname"/g)?.length ?? 0, c.sql).toBe(json.match(/"mantle":"table"/g)?.length ?? 0);
    }
  });
});

describe("validateIr on IR that never came from SQL", () => {
  it("refuses unknown keys, nodes and enums, the system and cte tags, another grammar, and malformed input, without throwing", async () => {
    const res = await compileSql("SELECT id FROM items ORDER BY id", ctxOf("view"));
    if (!res.ok) throw new Error("expected a plan");
    const verdict = (stmts: unknown, grammar = PG_GRAMMAR) => validateIr({ grammar, stmts: stmts as SqlNode[] }, ctxOf("view"))[0];
    const bad = (edit: (s: SqlNode[]) => void) => {
      const s = JSON.parse(JSON.stringify(res.plan.stmts)) as SqlNode[];
      edit(s);
      return verdict(s)?.code;
    };
    expect(verdict(res.plan.stmts)).toBeUndefined();
    expect(bad((s) => (s[0]!.SelectStmt.foo = 1))).toBe("SQL_UNSUPPORTED");
    expect(bad((s) => (s[0]!.SelectStmt.whereClause = { Bogus: {} }))).toBe("SQL_UNSUPPORTED");
    expect(bad((s) => (s[0]!.SelectStmt.op = "SETOP_UNION"))).toBe("SQL_UNSUPPORTED");
    expect(bad((s) => (s[0]!.SelectStmt.fromClause[0].RangeVar.mantle = "system"))).toBe("SQL_UNSUPPORTED");
    expect(bad((s) => (s[0]!.SelectStmt.fromClause[0].RangeVar.mantle = "cte"))).toBe("SQL_RELATION");
    expect(verdict(res.plan.stmts, 170004)?.code).toBe("SQL_UNSUPPORTED");
    for (const junk of [[], "nope", [null], [{ SelectStmt: null }]]) expect(verdict(junk)).toBeDefined();
    expect(validateIr(undefined as never, ctxOf("view"))[0]?.code).toBe("SQL_UNSUPPORTED");
  });
});
