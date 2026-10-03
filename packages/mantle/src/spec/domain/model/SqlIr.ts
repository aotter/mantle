/**
 * Store SQL and its IR (ADR-0034). The IR is libpg-query's parse tree for the
 * supported subset, with source locations stripped and every relation tagged
 * `table` or `cte`. Mantle designs no node types, so nodes are typed loosely on
 * purpose: the dialect's allowlist (`src/core/sql/allowlist.ts`), not a TypeScript type, constrains
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
  /** a declared timestamptz field the author writes; a row is invisible once it is `ttlSeconds` old (a NULL never expires) */
  readonly ttl?: string;
  readonly ttlSeconds?: number;
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
  /** a public View: a caller sees published rows only, even across a join */
  readonly public?: boolean;
  /**
   * The Views a FROM may name (ADR-0037 decision 3), by name with `-` as `_`: an internal View's compiled SELECT, which the
   * compiler inlines as a subquery, or why that View cannot be read. Compile side only.
   */
  readonly views?: Readonly<Record<string, { readonly select?: SqlNode; readonly refusal?: string }>>;
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

/** Whether an expression holds a subquery, by structure: a string literal 'SubLink' is not one. */
export function hasSubLink(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  return Object.entries(v).some(([k, c]) => k === "SubLink" || hasSubLink(c));
}
