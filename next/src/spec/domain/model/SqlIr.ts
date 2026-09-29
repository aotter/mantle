/**
 * Store SQL and its IR (ADR-0034). The IR is libpg-query's parse tree for the
 * supported subset, with source locations stripped and every relation tagged
 * `table` or `cte`. Mantle designs no node types, so nodes are typed loosely on
 * purpose: the allowlist in `SqlIrValidator`, not a TypeScript type, constrains
 * them.
 *
 * Pure types and constants only. Nothing here imports the parser.
 */
export type SqlNode = Record<string, any>;

/** The PostgreSQL grammar version a plan records (libpg-query 18: PG 18.0.4). */
export const PG_GRAMMAR = 180004;

export const SQL_DIAGNOSTIC_CODES = [
  "SQL_SYNTAX", // the parser could not read the text
  "SQL_UNSUPPORTED", // a node, key or value outside the subset (OFFSET, RIGHT JOIN, UNION, $1 ...)
  "SQL_FUNCTION", // a function that is not on the allowlist
  "SQL_RELATION", // an undeclared table, a _mantle_* table, or a cte reference that resolves to a Schema
  "SQL_COLUMN", // a scope, TTL or rowid column, or an undeclared input
  "SQL_WRITE", // a write that names a column Mantle fills, or has no column list
  "SQL_SHAPE", // LIMIT without ORDER BY, a JOIN without ON, a comma join, several VALUES rows
  "SQL_TYPE", // a CAST, interval unit or date_trunc field outside the supported set
] as const;
export type SqlDiagnosticCode = (typeof SQL_DIAGNOSTIC_CODES)[number];

export interface SqlSchemaDef {
  /** column that holds the owner; every read and write is filtered on it */
  readonly scope?: string;
  /** column holding an expiry in microseconds; expired rows are invisible */
  readonly ttl?: string;
  /** lifecycle `publishing`: a public caller sees only published rows */
  readonly publishing?: boolean;
  /** declared fields and their Mantle types: text integer real bool json timestamptz date numeric(p,s) geo */
  readonly fields: Readonly<Record<string, string>>;
}

export interface SqlContext {
  readonly schemas: Readonly<Record<string, SqlSchemaDef>>;
  /** declared input properties and their Mantle types */
  readonly inputs: Readonly<Record<string, string>>;
  readonly kind: "view" | "procedure";
}

/** A refusal of Store SQL. `line` and `column` are 1-based; `token` is the source text there. */
export interface SqlDiagnostic {
  readonly code: SqlDiagnosticCode;
  readonly message: string;
  readonly offset?: number;
  readonly line?: number;
  readonly column?: number;
  readonly token?: string;
}

/** What the plan carries for one SQL source: the grammar it was parsed by, and the IR statements. */
export interface SqlPlan {
  readonly grammar: number;
  readonly stmts: readonly SqlNode[];
}
