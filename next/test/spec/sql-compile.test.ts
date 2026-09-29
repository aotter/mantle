import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_CODES,
  PG_GRAMMAR,
  SQL_DIAGNOSTIC_CODES,
  compileSql,
  sqlDiagnosticToKernel,
  validateIr,
  type SqlContext,
  type SqlDiagnosticCode,
  type SqlNode,
} from "../../src/spec/index.js";
import { parsePgSql } from "../../src/spec/infrastructure/sql/PgQueryParser.js";

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
type Refusal = { sql: string; kind?: Kind; code: SqlDiagnosticCode; token?: string; msg?: RegExp };
const v = (sql: string, code: SqlDiagnosticCode, token?: string, msg?: RegExp): Refusal => ({ sql, code, token, msg });
const w = (sql: string, code: SqlDiagnosticCode, token?: string, msg?: RegExp): Refusal => ({ sql, kind: "procedure", code, token, msg });

/** Refusals from the spike's dialect corpus, in the ADR's order. `token` is asserted where the diagnostic has a position. */
const REFUSED: Refusal[] = [
  v("SELECT id FROM items OFFSET 2", "SQL_UNSUPPORTED", "OFFSET", /limitOffset/),
  v("SELECT id FROM items WHERE id = $1", "SQL_UNSUPPORTED", "$1", /ParamRef/),
  v("SELECT a.id FROM items a RIGHT JOIN orders o ON o.item_id = a.id", "SQL_UNSUPPORTED", "RIGHT", /JOIN_RIGHT/),
  w("UPDATE items SET stock = 1 FROM orders WHERE items.id = orders.item_id", "SQL_UNSUPPORTED", "FROM", /fromClause/),
  v("SELECT CURRENT_TIMESTAMP", "SQL_UNSUPPORTED", "CURRENT_TIMESTAMP", /SQLValueFunction/),
  v("WITH x AS (SELECT 1 AS a) SELECT a FROM x", "SQL_UNSUPPORTED", "WITH", /withClause/),
  v("SELECT id FROM items UNION SELECT id FROM orders", "SQL_UNSUPPORTED", "UNION", /SETOP_UNION/),
  v("SELECT id FROM items FOR UPDATE", "SQL_UNSUPPORTED", "FOR UPDATE", /lockingClause/),
  v("SELECT sum(stock) OVER (ORDER BY id ROWS 2 PRECEDING) FROM items", "SQL_UNSUPPORTED", "ROWS", /frameOptions/),
  v("SELECT id FROM items WHERE name ILIKE 'a'", "SQL_UNSUPPORTED", "ILIKE"),
  v("SELECT tags -> 0 FROM items", "SQL_UNSUPPORTED", undefined, /operator ->/),
  v('SELECT id AS "index" FROM items', "SQL_UNSUPPORTED", undefined, /SQLite keyword/),
  w("CREATE TABLE t (a int)", "SQL_UNSUPPORTED", undefined, /CreateStmt/),
  w("BEGIN", "SQL_UNSUPPORTED", undefined, /TransactionStmt/),
  v("SELECT sqlite_version()", "SQL_FUNCTION", "sqlite_version"),
  v("SELECT strftime('%Y', 0, 'unixepoch')", "SQL_FUNCTION", "strftime"),
  v("SELECT nextval('seq')", "SQL_FUNCTION", "nextval"),
  v("SELECT * FROM json_tree('[1]')", "SQL_FUNCTION", undefined, /json_each/),
  // code review: like_escape is only the ESCAPE of a LIKE
  v("SELECT id FROM items WHERE name = like_escape('a', '!')", "SQL_FUNCTION", undefined, /ESCAPE of a LIKE/),
  v("SELECT id FROM places WHERE near(places.loc, 25.0, 121.5, 60000)", "SQL_FUNCTION", undefined, /at most 50000/),
  v("SELECT id FROM nope", "SQL_RELATION", "nope"),
  v("SELECT id FROM _mantle_tz", "SQL_RELATION", "_mantle_tz"),
  v("SELECT 1 FROM items input", "SQL_RELATION", undefined, /reserved alias/),
  v("SELECT rowid FROM items", "SQL_COLUMN", "rowid"),
  v("SELECT id FROM items WHERE owner = 'o2'", "SQL_COLUMN", "owner", /scope and TTL/),
  v("SELECT id FROM items WHERE stock = input.nope", "SQL_COLUMN", "input.nope", /not a declared input/),
  w("UPDATE items SET owner = 'o2' WHERE id = 'a'", "SQL_WRITE", "owner"),
  w("UPDATE items SET version = 9 WHERE id = 'a'", "SQL_WRITE", "version"),
  w("INSERT INTO orders (id, item_id) VALUES ('x', 'a')", "SQL_WRITE", "id", /generates its ids/),
  w("INSERT INTO items VALUES ('x')", "SQL_WRITE", undefined, /column list/),
  w("UPDATE items SET nope = 1 WHERE id = 'a'", "SQL_WRITE", "nope", /no field nope/),
  v("SELECT a.id FROM items a CROSS JOIN orders o", "SQL_SHAPE", "CROSS JOIN", /JOIN needs ON/),
  v("SELECT a.id FROM items a, orders o", "SQL_SHAPE", undefined, /comma join/),
  v("SELECT id FROM items LIMIT 2", "SQL_SHAPE", "2", /LIMIT needs an ORDER BY/),
  v("SELECT DISTINCT cat FROM items ORDER BY cat", "SQL_SHAPE", undefined, /DISTINCT with ORDER BY/),
  w("INSERT INTO orders (item_id) VALUES ('a'), ('b')", "SQL_SHAPE", undefined, /one row/),
  w("UPDATE items SET stock = 1 WHERE id = 'a'; SELECT 1", "SQL_SHAPE", undefined, /write/),
  v("UPDATE items SET stock = 1 WHERE id = 'a'", "SQL_SHAPE", undefined, /one SELECT/),
  v("SELECT id FROM places ORDER BY distance(places.loc, 25.0, 121.5)", "SQL_SHAPE", undefined, /literal LIMIT/),
  // code review: a non-literal CAST to int is refused (SQLite truncates, PostgreSQL rounds) and asks for round(x)
  v("SELECT CAST(stock AS int) FROM items", "SQL_TYPE", "CAST", /Write round\(x\)/),
  v("SELECT CAST(stock AS varchar) FROM items", "SQL_TYPE", undefined, /varchar/),
  v("SELECT interval '1 day'", "SQL_TYPE", undefined, /bind the boundary as an input/),
  // code review: interval units match exactly, so a prefix or a look-alike is not a unit
  v("SELECT interval '1 ms'", "SQL_TYPE", undefined, /not supported/),
  v("SELECT date_trunc('century', now())", "SQL_TYPE", undefined, /date_trunc takes/),
  v("SELECT '1.234'::numeric(16, 2)", "SQL_TYPE", undefined, /precision is at most 15/),
  v("SELECT id FROM items WHERE", "SQL_SYNTAX"),
  v("SELEC id FROM items", "SQL_SYNTAX", "SELEC"),
  w("INSERT OR REPLACE INTO settings (key) VALUES ('x')", "SQL_SYNTAX", "OR"),
];

const ACCEPTED_EXTRA: Array<[string, Kind, string]> = [
  ["cast literal int", "view", "SELECT CAST('5' AS int), CAST(7 AS int), round(stock) FROM items"],
  ["interval hours", "view", "SELECT id FROM events WHERE at > now() - interval '36 hours' ORDER BY id"],
  ["like escape", "view", "SELECT id FROM items WHERE name LIKE 'a!%' ESCAPE '!' ORDER BY id"],
  ["upsert", "procedure", "INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO NOTHING RETURNING key"],
];

const ctxOf = (kind: Kind, inputs: Record<string, string> = {}): SqlContext => ({ schemas, inputs, kind });

describe("compileSql refusals", () => {
  it.each(REFUSED.map((r) => [r.sql, r] as const))("%s", async (_sql, r) => {
    const res = await compileSql(r.sql, ctxOf(r.kind ?? "view"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostic.code).toBe(r.code);
    if (r.token !== undefined) expect(res.diagnostic.token).toBe(r.token);
    if (r.msg) expect(res.diagnostic.message).toMatch(r.msg);
  });

  it("every one of the 8 codes is exercised, and the ones with a token carry line, column and token", async () => {
    expect(new Set(REFUSED.map((r) => r.code))).toEqual(new Set(SQL_DIAGNOSTIC_CODES));
    for (const code of SQL_DIAGNOSTIC_CODES) {
      const r = REFUSED.find((x) => x.code === code && x.token !== undefined)!;
      const res = await compileSql(r.sql, ctxOf(r.kind ?? "view"));
      if (res.ok) throw new Error("expected a refusal");
      expect(res.diagnostic).toMatchObject({ code, token: r.token });
      expect(res.diagnostic.line).toBeGreaterThanOrEqual(1);
      expect(res.diagnostic.column).toBeGreaterThanOrEqual(1);
    }
  });

  it("points at the right line and column in a multi-line source", async () => {
    const res = await compileSql("SELECT id\nFROM items\n  WHERE id = 1\nOFFSET 3", ctxOf("view"));
    if (res.ok) throw new Error("expected a refusal");
    expect(res.diagnostic).toMatchObject({ code: "SQL_UNSUPPORTED", line: 4, column: 1, token: "OFFSET" });
  });

  it("the runtime validator refuses the bare IR of every structural refusal too", async () => {
    for (const r of REFUSED.filter((x) => x.code !== "SQL_SYNTAX")) {
      const kind = r.kind ?? "view";
      const parsed = await parsePgSql(r.sql);
      const verdict = validateIr({ grammar: PG_GRAMMAR, stmts: parsed.stmts }, ctxOf(kind));
      expect(verdict[0]?.code, r.sql).toBe(r.code);
    }
  });

  it("declares its codes in the diagnostic kernel and converts a refusal", async () => {
    for (const code of SQL_DIAGNOSTIC_CODES) expect(DIAGNOSTIC_CODES).toContain(code);
    const res = await compileSql("SELECT id FROM items OFFSET 2", ctxOf("view"));
    if (res.ok) throw new Error("expected a refusal");
    const d = sqlDiagnosticToKernel(res.diagnostic, { path: "/spec/sql", sourceId: "views.yaml" });
    expect(d).toMatchObject({ code: "SQL_UNSUPPORTED", phase: "validate", severity: "error", path: "/spec/sql", value: "OFFSET" });
    expect(d.source?.span?.start).toMatchObject({ line: 1, column: 22 });
  });
});

describe("compileSql accepts the spike corpus", () => {
  const corpus = JSON.parse(readFileSync(new URL("./fixtures/sql-corpus.json", import.meta.url), "utf8")) as Array<{
    id: string;
    kind: Kind;
    sql: string;
    inputs?: Record<string, string>;
  }>;

  it.each(corpus.map((c) => [c.id, c] as const))("%s: compile, then the runtime validator agrees", async (_id, c) => {
    const res = await compileSql(c.sql, ctxOf(c.kind, c.inputs));
    if (!res.ok) throw new Error(`refused: ${JSON.stringify(res.diagnostic)}`);
    expect(res.plan.grammar).toBe(PG_GRAMMAR);
    expect(validateIr(res.plan, ctxOf(c.kind, c.inputs))).toEqual([]);
    // the IR is plain JSON with no source locations
    expect(JSON.stringify(res.plan)).not.toContain('"location"');
  });

  it.each(ACCEPTED_EXTRA)("%s", async (_name, kind, sql) => {
    const res = await compileSql(sql, ctxOf(kind));
    expect(res.ok).toBe(true);
  });

  it("tags every relation and records grammar 180004", async () => {
    const res = await compileSql("SELECT i.id FROM items i JOIN orders o ON o.item_id = i.id ORDER BY i.id", ctxOf("view"));
    if (!res.ok) throw new Error("expected a plan");
    expect(PG_GRAMMAR).toBe(180004);
    const relations: unknown[] = [];
    JSON.stringify(res.plan.stmts, (_k, val) => (val && typeof val === "object" && "relname" in val ? (relations.push(val.mantle), val) : val));
    expect(relations).toEqual(["table", "table"]);
  });
});

describe("validateIr on IR that never came from SQL", () => {
  const base = async (): Promise<SqlNode[]> => {
    const res = await compileSql("SELECT id FROM items ORDER BY id", ctxOf("view"));
    if (!res.ok) throw new Error("expected a plan");
    return JSON.parse(JSON.stringify(res.plan.stmts)) as SqlNode[];
  };
  const verdict = (stmts: unknown, grammar: number = PG_GRAMMAR) => validateIr({ grammar, stmts: stmts as SqlNode[] }, ctxOf("view"))[0];
  const bad = async (edit: (s: SqlNode[]) => void) => {
    const s = await base();
    edit(s);
    return verdict(s);
  };

  it("refuses an unknown key, an unknown node, an enum outside the subset and the physical system tag", async () => {
    expect(await bad((s) => (s[0]!.SelectStmt.foo = 1))).toMatchObject({ code: "SQL_UNSUPPORTED", message: expect.stringContaining("SelectStmt.foo") });
    expect(await bad((s) => (s[0]!.SelectStmt.whereClause = { Bogus: {} }))).toMatchObject({ code: "SQL_UNSUPPORTED", message: expect.stringContaining("Bogus") });
    expect(await bad((s) => (s[0]!.SelectStmt.op = "SETOP_UNION"))).toMatchObject({ code: "SQL_UNSUPPORTED", message: expect.stringContaining("SETOP_UNION") });
    expect(await bad((s) => (s[0]!.SelectStmt.fromClause[0].RangeVar.mantle = "system"))).toMatchObject({ code: "SQL_UNSUPPORTED" });
  });

  it("refuses a cte reference, whether or not it carries a Schema's name", async () => {
    expect(await bad((s) => (s[0]!.SelectStmt.fromClause[0].RangeVar.mantle = "cte"))).toMatchObject({ code: "SQL_RELATION", message: expect.stringContaining("not defined in scope") });
    expect(await bad((s) => Object.assign(s[0]!.SelectStmt.fromClause[0].RangeVar, { relname: "nowhere", mantle: "cte" }))).toMatchObject({ code: "SQL_RELATION" });
  });

  it("refuses a plan built by another PostgreSQL grammar", async () => {
    expect(verdict(await base(), 170004)).toMatchObject({ code: "SQL_UNSUPPORTED", message: expect.stringContaining("170004") });
    expect(verdict(await base())).toBeUndefined();
  });

  it("refuses malformed input instead of throwing", async () => {
    expect(verdict([])).toMatchObject({ code: "SQL_SHAPE" });
    expect(verdict("nope")).toMatchObject({ code: "SQL_SHAPE" });
    expect(verdict([null])).toBeDefined();
    expect(verdict([{ SelectStmt: null }])).toBeDefined();
    expect(validateIr(undefined as never, ctxOf("view"))[0]).toMatchObject({ code: "SQL_UNSUPPORTED" });
  });
});
