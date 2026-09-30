/** SqliteStoreExecutor: the only StoreExecutor (ADR-0034 decision 6). Prints IR and runs it on a DatabaseDriver. */
import { DiagnosticError, runtimeDiagnostic, type Diagnostic } from "../spec/kernel/index.js";
import type { DatabaseDriver, SqlStatement } from "../core/driver.js";
import type { StoreExecutor, StoreRow } from "../core/store.js";
import { print } from "./print.js";

type Statement = Parameters<StoreExecutor["select"]>[0];

const fail = (code: Diagnostic["code"], message: string, conflict?: Diagnostic["conflict"]) =>
  new DiagnosticError(runtimeDiagnostic({ code, severity: "error", path: "store", message, ...(conflict ? { conflict } : {}) }));

function mapError(kind: "select" | "apply") {
  return (e: unknown): never => mapped(e, kind);
}

function mapped(e: unknown, kind: "select" | "apply"): never {
  const message = e instanceof Error ? e.message : String(e);
  const op = /CONFLICT op=(\d+)/.exec(message);
  if (op) throw fail("CONFLICT", `CONFLICT op=${op[1]}: the write matched a different number of rows than it expected`, { opIndex: Number(op[1]), reason: "expect" });
  // the trigger's marker, then "<schema>: <expression>" up to the engine's own suffix (the expression may hold colons)
  const check = /MANTLE_CHECK (.*?): SQLITE_CONSTRAINT/s.exec(message);
  if (check) throw fail("INPUT_VALIDATION_FAILED", `CHECK ${check[1]}`);
  if (/cannot store \w+ value in \w+ column/.test(message)) throw fail("INPUT_VALIDATION_FAILED", "A value does not fit its column's type.");
  // the driver's own text names tables and columns, so it stays out of the Diagnostic
  if (/UNIQUE constraint failed/.test(message)) throw fail("CONFLICT", "A unique constraint of the Schema was violated.", { reason: "unique" });
  if (/ON CONFLICT clause does not match/.test(message)) throw fail("INPUT_VALIDATION_FAILED", "onConflict.columns must match a unique index of the Schema.");
  if (/NOT NULL constraint failed/.test(message)) throw fail("INPUT_VALIDATION_FAILED", "A required column has no value; a scoped Schema needs a caller identity.");
  // the engine answered and refused (a constraint, a type, a syntax problem): the write did not happen
  if (/SQLITE_[A-Z_]+/.test(message)) throw fail("INPUT_VALIDATION_FAILED", "The database refused the statement.");
  // no answer (the connection dropped, a timeout): a read can be retried, a write may or may not have landed and must be reconciled
  throw fail(kind === "apply" ? "OUTCOME_UNKNOWN" : "RESOURCE_UNAVAILABLE", kind === "apply" ? "The database did not answer; the write may or may not have been applied." : "The database did not answer.");
}

export class SqliteStoreExecutor implements StoreExecutor {
  constructor(private readonly driver: DatabaseDriver, readonly maxBindings = 100) {}

  private prepared(s: Statement): SqlStatement {
    if (s.binds.length > this.maxBindings) throw fail("INPUT_VALIDATION_FAILED", `a statement binds ${s.binds.length} values; the limit is ${this.maxBindings}`);
    return { sql: print(s.ir), binds: s.binds };
  }

  async select(statement: Statement): Promise<readonly StoreRow[]> {
    const [res] = await this.driver.batch([this.prepared(statement)]).catch(mapError("select"));
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
    const res = await this.driver.batch(sent).catch(mapError("apply"));
    return batch.map((_s, i) => ({ affected: Number(res[at[i]! + 1]!.rows[0]!.n), rows: res[at[i]!]!.rows }));
  }
}
