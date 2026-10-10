/**
 * Canonical migrations (ADR-0033 decision 4): Core's product tables (`site_config`, `media_assets`, `pending_media_uploads`) and the
 * tables of an optional package (Better Auth's) change with Mantle releases and sometimes need data moves, so they are versioned
 * in `_mantle_migrations`, never converged. Schema tables are the plan's and go through `convergeStorage`.
 */
import { DiagnosticError, makeDiagnostic } from "../spec/kernel/index.js";
import type { DatabaseDriver } from "../core/driver.js";
import { readRows } from "./read.js";

export interface Migration {
  readonly id: string;
  readonly sql: string;
  /** The product tables it creates (ADR-0032 decision 11): one that exists before its ledger row is someone else's, and boot stops. */
  readonly tables?: readonly string[];
}

const LEDGER = "_mantle_migrations";

/** Applies each migration not yet in the ledger, its statements and its ledger row in one batch, so it lands whole or not at all. */
export async function runMigrations(driver: DatabaseDriver, migrations: readonly Migration[]): Promise<void> {
  if (!(await readRows(driver, { sql: "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?1", binds: [LEDGER] })).length)
    await driver.batch([{ sql: `CREATE TABLE IF NOT EXISTS ${LEDGER} (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)` }]);
  const applied = await readRows(driver, { sql: `SELECT id FROM ${LEDGER}` });
  const seen = new Set(applied.map((r) => String(r.id)));
  for (const m of migrations) {
    if (seen.has(m.id)) continue;
    if (m.tables?.length) {
      const found = await readRows(driver, { sql: `SELECT name FROM sqlite_schema WHERE type = 'table' AND lower(name) IN (${m.tables.map((_, i) => `?${i + 1}`).join(", ")})`, binds: m.tables.map((t) => t.toLowerCase()) });
      const won = await readRows(driver, { sql: `SELECT id FROM ${LEDGER} WHERE id = ?1`, binds: [m.id] });
      // the migration and its ledger row land in one batch, so a table without the row was never ours
      if (won.length) { seen.add(m.id); continue; }
      if (found.length)
        throw new DiagnosticError(found.map((r) => makeDiagnostic({ code: "STORAGE_TABLE_NOT_OWNED", phase: "boot", severity: "error", path: `storage:${String(r.name)}`, message: `table ${String(r.name)} exists and Mantle's migration ${m.id} did not create it, so it is not read or written; rename it or move it away` })));
    }
    try {
      await driver.batch([...splitSqlStatements(m.sql).map((sql) => ({ sql })), { sql: `INSERT INTO ${LEDGER} (id, applied_at) VALUES (?1, ?2)`, binds: [m.id, Date.now()] }]);
    } catch (error) {
      // a concurrent isolate applied it first: the ledger row is the proof, anything else is a real failure
      const won = await readRows(driver, { sql: `SELECT id FROM ${LEDGER} WHERE id = ?1`, binds: [m.id] });
      if (!won.length) throw error;
    }
    seen.add(m.id);
  }
}

/** A migration is SQL text with several statements; D1 takes one per prepared statement. Splits at `;` outside strings, identifiers and comments. */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let state: "sql" | "single" | "double" | "backtick" | "bracket" | "line" | "block" = "sql";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (state === "line") { if (c === "\n") state = "sql"; continue; }
    if (state === "block") { if (c === "*" && n === "/") { state = "sql"; i++; } continue; }
    if (state !== "sql") {
      const close = state === "single" ? "'" : state === "double" ? '"' : state === "backtick" ? "`" : "]";
      if (c === close) { if (state !== "bracket" && n === close) i++; else state = "sql"; }
      continue;
    }
    if (c === "-" && n === "-") { state = "line"; i++; continue; }
    if (c === "/" && n === "*") { state = "block"; i++; continue; }
    if (c === "'") { state = "single"; continue; }
    if (c === '"') { state = "double"; continue; }
    if (c === "`") { state = "backtick"; continue; }
    if (c === "[") { state = "bracket"; continue; }
    if (c === ";") { const s = sql.slice(start, i).trim(); if (s) out.push(s); start = i + 1; }
  }
  if (state !== "sql" && state !== "line") throw new Error("Unterminated token in a migration.");
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}
