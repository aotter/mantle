/** SqliteStoreExecutor: the only StoreExecutor (ADR-0034 decision 6). Prints IR and runs it on a DatabaseDriver. */
import { DiagnosticError, runtimeDiagnostic, type Diagnostic } from "../../spec/index.js";
import type { DatabaseDriver, SqlStatement } from "../driver.js";
import type { StoreExecutor, StoreRow } from "../store.js";
import { print } from "./print.js";

type Statement = Parameters<StoreExecutor["select"]>[0];

const fail = (code: Diagnostic["code"], message: string, conflict?: Diagnostic["conflict"]) =>
  new DiagnosticError(runtimeDiagnostic({ code, severity: "error", path: "store", message, ...(conflict ? { conflict } : {}) }));

function mapError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  const op = /CONFLICT op=(\d+)/.exec(message);
  if (op) throw fail("CONFLICT", message, { opIndex: Number(op[1]), reason: "expect" });
  const check = /(CHECK \w+: [^:]*?)(?: at offset|: SQLITE|$)/.exec(message);
  if (check) throw fail("INPUT_VALIDATION_FAILED", check[1]!);
  // the driver's own text names tables and columns, so it stays out of the Diagnostic
  if (/UNIQUE constraint failed/.test(message)) throw fail("CONFLICT", "A unique constraint of the Schema was violated.", { reason: "unique" });
  if (/ON CONFLICT clause does not match/.test(message)) throw fail("INPUT_VALIDATION_FAILED", "onConflict.columns must match a unique index of the Schema.");
  if (/NOT NULL constraint failed/.test(message)) throw fail("INPUT_VALIDATION_FAILED", "A required column has no value; a scoped Schema needs a caller identity.");
  throw e;
}

export class SqliteStoreExecutor implements StoreExecutor {
  constructor(private readonly driver: DatabaseDriver, readonly maxBindings = 100) {}

  private prepared(s: Statement): SqlStatement {
    if (s.binds.length > this.maxBindings) throw fail("INPUT_VALIDATION_FAILED", `a statement binds ${s.binds.length} values; the limit is ${this.maxBindings}`);
    return { sql: print(s.ir), binds: s.binds };
  }

  async select(statement: Statement): Promise<readonly StoreRow[]> {
    const [res] = await this.driver.batch([this.prepared(statement)]).catch(mapError);
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
    const res = await this.driver.batch(sent).catch(mapError);
    return batch.map((_s, i) => ({ affected: Number(res[at[i]! + 1]!.rows[0]!.n), rows: res[at[i]!]!.rows }));
  }
}
