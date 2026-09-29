// Shared shapes. The IR is libpg-query's parse tree, so nodes are typed loosely here on purpose:
// the allowlist in validate.ts, not the TypeScript type, is what constrains them.
export type N = Record<string, any>;

export type SchemaDef = {
  /** column that holds the owner; every read and write is filtered on it */
  scope?: string;
  /** column holding an expiry in microseconds; expired rows are invisible */
  ttl?: string;
  /** lifecycle `publishing`: a public caller sees only `status = 'published'` */
  publishing?: boolean;
  /** declared fields and their Mantle types: text integer real bool json timestamptz date numeric(p,s) geo */
  fields: Record<string, string>;
  /** boolean expressions over the row's own columns, enforced by triggers */
  checks?: string[];
  /** fields indexed by FTS5 (trigram) */
  search?: string[];
  /** unique constraints; on a scoped Schema the scope column is added */
  unique?: string[][];
};
export type Schemas = Record<string, SchemaDef>;

export type Ctx = {
  schemas: Schemas;
  /** declared input properties and their Mantle types */
  inputs: Record<string, string>;
  kind: 'view' | 'procedure';
  /** SQL source, only to turn offsets into tokens for diagnostics */
  source?: string;
};

export type Diagnostic = { code: string; message: string; offset?: number; line?: number; column?: number; token?: string };

/**
 * Diagnostic codes this spike proposes for ADR-0032 decision 5's table.
 *  SQL_SYNTAX       libpg-query could not parse the text
 *  SQL_UNSUPPORTED  a node, key or value outside the chosen subset (OFFSET, RIGHT JOIN, UNION, $1 ...)
 *  SQL_FUNCTION     a function that is not on the allowlist
 *  SQL_RELATION     an undeclared table, a _mantle_* table, or a cte reference that resolves to a Schema
 *  SQL_COLUMN       a scope, TTL or rowid column, or an undeclared input
 *  SQL_WRITE        a write that names a column Mantle fills, or has no column list
 *  SQL_SHAPE        LIMIT without ORDER BY, a JOIN without ON, a comma join, VALUES with several rows
 *  SQL_TYPE         a CAST (a non-literal CAST to int included: write round(x)), interval unit or date_trunc field outside the supported set
 */
export const CODES = ['SQL_SYNTAX', 'SQL_UNSUPPORTED', 'SQL_FUNCTION', 'SQL_RELATION', 'SQL_COLUMN', 'SQL_WRITE', 'SQL_SHAPE', 'SQL_TYPE'] as const;
export type Code = (typeof CODES)[number];

export class Refused extends Error {
  code: Code;
  offset?: number;
  /** the keyword the refusal is about; the parser gives no position for a clause key, so the CLI finds this in the source */
  keyword?: RegExp;
  constructor(code: Code, message: string, offset?: number, keyword?: RegExp) {
    super(message);
    this.code = code;
    this.offset = offset;
    this.keyword = keyword;
  }
}
