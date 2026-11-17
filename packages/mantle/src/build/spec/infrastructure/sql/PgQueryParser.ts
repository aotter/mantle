/**
 * The only file in `packages/mantle/src` that imports `libpg-query`. CLI side only (ADR-0034 decision 3):
 * The WASM parser stays outside Workers. The import is dynamic so that even a bundle that
 * re-exports the compiler does not instantiate the WASM until something compiles SQL.
 * `check:boundaries` fails when a file outside `spec` names the package, and the preset test bundles a
 * generated Worker and fails if the package is in it.
 */
import type { SqlNode } from "../../domain/model/SqlIr.js";
import { SqlRefusal } from "../../domain/service/SqlRefusal.js";

export interface ParsedSql {
  /** the `stmt` of each RawStmt */
  readonly stmts: SqlNode[];
  /** UTF-8 byte offset of each statement in the source */
  readonly locations: (number | undefined)[];
}

/** Parse PostgreSQL-syntax text. A parse failure is an `SQL_SYNTAX` refusal at the parser's cursor. */
export async function parsePgSql(sql: string): Promise<ParsedSql> {
  const { loadModule, parse } = await import("libpg-query");
  // A runtime that cannot load the parser is an error, not SQL_SYNTAX.
  await loadModule().catch(cause => {
    throw new Error(
      "The SQL parser (libpg-query WASM) cannot load in this runtime; compile SQL manifests with Node.js or Bun.",
      { cause },
    );
  });
  let tree;
  try {
    tree = await parse(sql);
  } catch (e: any) {
    const at = e?.sqlDetails?.cursorPosition; // a character index, not a byte offset
    // libpg-query prefixes "syntax error at or near ..." messages with its own noise; keep the part after the first colon
    throw new SqlRefusal(
      "SQL_SYNTAX",
      String(e?.message ?? e).replace(/^.*?:\s*/, ""),
      typeof at === "number" ? new TextEncoder().encode(sql.slice(0, at)).byteLength : undefined,
    );
  }
  const raw = tree.stmts as SqlNode[];
  return { stmts: raw.map(s => s.stmt), locations: raw.map(s => s.stmt_location) };
}
