/**
 * Store SQL and its IR (ADR-0034). The IR is libpg-query's parse tree for the
 * supported subset, with source locations stripped and every relation tagged
 * `table` or `cte`. Mantle designs no node types, so nodes are typed loosely on
 * purpose: the allowlist in `SqlIrValidator`, not a TypeScript type, constrains
 * them.
 *
 * Pure types and constants only. Nothing here imports the parser.
 */
import type { DiagnosticCode } from "../../kernel/diagnostic.js";
export type SqlNode = Record<string, any>;

/** The PostgreSQL grammar version a plan records (libpg-query 18: PG 18.0.4). */
export const PG_GRAMMAR = 180004;

/** The `SQL_*` codes of the diagnostic kernel; each is described in docs/handbook/reference/diagnostics.md. */
export type SqlDiagnosticCode = Extract<DiagnosticCode, `SQL_${string}`>;

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
