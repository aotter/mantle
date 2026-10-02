/** PgStoreExecutor: the PostgreSQL dialect's StoreExecutor. Prints IR (`typed`, then the deparser) and runs it over `PgConnect`. */
import { DiagnosticError, runtimeDiagnostic, type Diagnostic } from "../spec/kernel/index.js";
import type { StorageSchema } from "../core/dialect.js";
import type { StoreApplied, StoreExecutor, StoreRow, StoreStatement } from "../core/store.js";
import { query, sqlState, transaction, type PgConnect, type PgError, type PgStatement } from "./driver.js";
import { print, typed } from "./print.js";

const fail = (code: Diagnostic["code"], message: string, conflict?: Diagnostic["conflict"]) =>
  new DiagnosticError(runtimeDiagnostic({ code, severity: "error", path: "store", message, ...(conflict ? { conflict } : {}) }));

export class PgStoreExecutor implements StoreExecutor {
  /** PostgreSQL takes 65535 binds; Core's validator reads this. */
  readonly maxBindings = 10_000;
  constructor(
    private readonly connect: PgConnect,
    private readonly schemas: Readonly<Record<string, StorageSchema>>,
    /** Check constraint name -> "<schema>: <expression>", the message D1 gives for the same check. */
    private readonly checks: ReadonlyMap<string, string>,
    private readonly timeoutMs?: number,
  ) {}

  private prepared(s: StoreStatement): PgStatement {
    if (s.binds.length > this.maxBindings) throw fail("INPUT_VALIDATION_FAILED", `a statement binds ${s.binds.length} values; the limit is ${this.maxBindings}`);
    return { text: print(typed(s.ir, this.schemas)), values: s.binds };
  }

  async select(statement: StoreStatement): Promise<readonly StoreRow[]> {
    const s = this.prepared(statement);
    return (await query(this.connect, s, this.timeoutMs).catch((e) => this.mapped(e, "select"))).rows;
  }

  async apply(batch: readonly StoreStatement[]): Promise<readonly StoreApplied[]> {
    const statements = batch.map((s) => this.prepared(s));
    // a write's count is checked where it ran, inside the transaction: a mismatch rolls the whole batch back
    const out = await transaction(this.connect, statements, (i, o) => {
      const expect = batch[i]!.expect;
      if (expect !== undefined && o.count !== expect) throw fail("CONFLICT", `CONFLICT op=${i}: the write matched a different number of rows than it expected`, { opIndex: i, reason: "expect" });
    }, this.timeoutMs).catch((e) => this.mapped(e, "apply"));
    return out.map((o) => ({ affected: o.count, rows: o.rows }));
  }

  private mapped(e: unknown, kind: "select" | "apply"): never {
    if (e instanceof DiagnosticError) throw e;
    const state = sqlState(e);
    const { statement: at, committing } = e as { statement?: number; committing?: boolean };
    const op = kind === "apply" && at !== undefined && at >= 0 ? { opIndex: at } : {};
    switch (state) {
      // the engine names the statement that failed, so a unique conflict always knows its op
      case "23505": throw fail("CONFLICT", "A unique constraint of the Schema was violated.", { reason: "unique", ...op });
      case "23514": throw fail("INPUT_VALIDATION_FAILED", `CHECK ${this.checks.get((e as PgError).constraint ?? "") ?? "a check of the Schema failed"}`);
      case "23502": throw fail("INPUT_VALIDATION_FAILED", "A required column has no value; a scoped Schema needs a caller identity.");
      case "42P10": throw fail("INPUT_VALIDATION_FAILED", "onConflict.columns must match a unique index of the Schema.");
      case "40001": case "40P01": throw fail("RESOURCE_UNAVAILABLE", "The database stayed too busy to apply the write; nothing was written.");
    }
    // the connection, the credentials, resources, an operator or the server itself: never the caller's input
    const down = !state || /^(08|28|53|57|58|XX)/.test(state);
    if (down && kind === "apply" && committing) throw fail("OUTCOME_UNKNOWN", "The database did not answer the commit; the write may or may not have been applied.");
    if (down) throw fail("RESOURCE_UNAVAILABLE", kind === "apply" ? "The database is unavailable; nothing was written." : "The database is unavailable.");
    // a data exception (a value that does not fit its column), or any other refusal: the write did not happen
    if (state?.startsWith("22")) throw fail("INPUT_VALIDATION_FAILED", "A value does not fit its column's type.");
    throw fail("INPUT_VALIDATION_FAILED", `The database refused the statement (SQLSTATE ${state}).`);
  }
}
