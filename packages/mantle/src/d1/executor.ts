/** SqliteStoreExecutor: the only StoreExecutor (ADR-0034 decision 6). Prints IR and runs it on a DatabaseDriver. */
import { DiagnosticError, runtimeDiagnostic, type Diagnostic } from "../spec/kernel/index.js";
import type { DatabaseDriver, SqlStatement } from "../core/driver.js";
import type { StoreExecutor, StoreRow } from "../core/store.js";
import { print } from "./print.js";

type Statement = Parameters<StoreExecutor["select"]>[0];

const fail = (code: Diagnostic["code"], message: string, conflict?: Diagnostic["conflict"]) =>
  new DiagnosticError(runtimeDiagnostic({ code, severity: "error", path: "store", message, ...(conflict ? { conflict } : {}) }));

function mapError(kind: "select" | "apply", writes: readonly (string | undefined)[] = []) {
  return (e: unknown): never => mapped(e, kind, writes);
}

/** The table a statement writes, lower-cased, or undefined for a read. */
function writeTarget(ir: Statement["ir"]): string | undefined {
  const node = (ir as Record<string, { relation?: { relname?: string } }>);
  const stmt = node.InsertStmt ?? node.UpdateStmt ?? node.DeleteStmt;
  return stmt?.relation?.relname?.toLowerCase();
}

/** SQLite's primary codes that say nothing about the statement: a lock, memory, I/O, a full disk, an interrupt. */
const TRANSIENT_CODES = new Set([5, 6, 7, 9, 10, 13]);
const TRANSIENT = /SQLITE_(BUSY|LOCKED|NOMEM|IOERR|FULL|INTERRUPT)/;

/**
 * How the engine answered. D1 writes `SQLITE_…` into the message; bun:sqlite and libSQL put an extended code in `code` (bun only
 * for extended codes: a plain SQLITE_ERROR is a `SQLiteError` with `errno` 1), node:sqlite gives a numeric `errcode`.
 * `transient` (busy, I/O, full) says nothing about the statement and is treated as no answer: a commit that hit it may have landed.
 */
function engineAnswer(e: unknown, message: string): "refused" | "transient" | "none" {
  const { code, errcode, errno, name } = (e ?? {}) as { code?: unknown; errcode?: unknown; errno?: unknown; name?: unknown };
  const primary = typeof errcode === "number" ? errcode & 0xff : name === "SQLiteError" && typeof errno === "number" ? errno & 0xff : undefined;
  const text = `${message} ${typeof code === "string" ? code : ""}`;
  if ((primary !== undefined && TRANSIENT_CODES.has(primary)) || TRANSIENT.test(text)) return "transient";
  return /SQLITE_[A-Z_]+/.test(text) || primary !== undefined ? "refused" : "none";
}

function mapped(e: unknown, kind: "select" | "apply", writes: readonly (string | undefined)[] = []): never {
  const message = e instanceof Error ? e.message : String(e);
  const op = /CONFLICT op=(\d+)/.exec(message);
  if (op) throw fail("CONFLICT", `CONFLICT op=${op[1]}: the write matched a different number of rows than it expected`, { opIndex: Number(op[1]), reason: "expect" });
  // the trigger's marker, then "<schema>: <expression>" up to the engine's own suffix (the expression may hold colons)
  // D1 appends ": SQLITE_CONSTRAINT"; other drivers end the message at the check (the expression may hold colons)
  const check = /MANTLE_CHECK (.*?)(?:: SQLITE_CONSTRAINT.*)?$/s.exec(message);
  if (check) throw fail("INPUT_VALIDATION_FAILED", `CHECK ${check[1]}`);
  if (/cannot store \w+ value in \w+ column/.test(message)) throw fail("INPUT_VALIDATION_FAILED", "A value does not fit its column's type.");
  // the driver's own text names tables and columns, so it stays out of the Diagnostic
  const unique = /UNIQUE constraint failed: "?(\w+)"?\./.exec(message);
  if (unique || /UNIQUE constraint failed/.test(message)) {
    // the engine names the table, never the statement: the op is known when exactly one statement of the batch writes that table
    const table = unique?.[1]?.toLowerCase();
    const ops = table ? writes.flatMap((t, i) => (t === table ? [i] : [])) : [];
    throw fail("CONFLICT", "A unique constraint of the Schema was violated.", { reason: "unique", ...(ops.length === 1 ? { opIndex: ops[0]! } : {}) });
  }
  if (/ON CONFLICT clause does not match/.test(message)) throw fail("INPUT_VALIDATION_FAILED", "onConflict.columns must match a unique index of the Schema.");
  if (/NOT NULL constraint failed/.test(message)) throw fail("INPUT_VALIDATION_FAILED", "A required column has no value; a scoped Schema needs a caller identity.");
  // the engine answered and refused (a constraint, a type, a syntax problem): the write did not happen
  if (engineAnswer(e, message) === "refused") throw fail("INPUT_VALIDATION_FAILED", "The database refused the statement.");
  // no answer (the connection dropped, a timeout): a read can be retried, a write may or may not have landed and must be reconciled
  throw fail(kind === "apply" ? "OUTCOME_UNKNOWN" : "RESOURCE_UNAVAILABLE", kind === "apply" ? "The database did not answer; the write may or may not have been applied." : "The database did not answer.");
}

export class SqliteStoreExecutor implements StoreExecutor {
  constructor(private readonly driver: DatabaseDriver, readonly maxBindings = 100) {}

  /** The printed form of an IR, once: a sealed plan's compiled statements are the same objects on every request (see PgStoreExecutor). */
  private readonly printed = new WeakMap<object, string>();

  private prepared(s: Statement): SqlStatement {
    if (s.binds.length > this.maxBindings) throw fail("INPUT_VALIDATION_FAILED", `a statement binds ${s.binds.length} values; the limit is ${this.maxBindings}`);
    let sql = this.printed.get(s.ir);
    if (sql === undefined) this.printed.set(s.ir, (sql = print(s.ir)));
    return { sql, binds: s.binds };
  }

  async select(statement: Statement): Promise<readonly StoreRow[]> {
    const s = this.prepared(statement);
    if (this.driver.all) return this.driver.all(s).catch(mapError("select"));
    const [res] = await this.driver.batch([s]).catch(mapError("select"));
    return res!.rows;
  }

  async apply(batch: readonly Statement[]): ReturnType<StoreExecutor["apply"]> {
    const sent: SqlStatement[] = [];
    const at: number[] = [];
    batch.forEach((s, i) => {
      at[i] = sent.length;
      sent.push(this.prepared(s));
      // count with SQLite's changes(), not D1's meta.changes, which includes rows that triggers wrote
      sent.push({ sql: "SELECT changes() AS n" });
      if (s.expect !== undefined) sent.push({ sql: `INSERT INTO _mantle_assert (op, ok) SELECT ${i}, changes() = ${Number(s.expect)}` });
    });
    const res = await this.driver.batch(sent).catch(mapError("apply", batch.map((s) => writeTarget(s.ir))));
    return batch.map((_s, i) => ({ affected: Number(res[at[i]! + 1]!.rows[0]!.n), rows: res[at[i]!]!.rows }));
  }
}
