/** PgStoreExecutor: the PostgreSQL dialect's StoreExecutor. Prints IR (`typed`, then the deparser) and runs it over `PgConnect`. */
import { DiagnosticError, runtimeDiagnostic, type Diagnostic } from "../spec/kernel/index.js";
import type { StorageSchema } from "../core/dialect.js";
import type { StoreApplied, StoreExecutor, StoreRow, StoreStatement } from "../core/store.js";
import { query, sqlState, transaction, type PgConnect, type PgError, type PgStatement } from "./driver.js";
import { EXPECT_STATE } from "./storage.js";
import { print, typed } from "./print.js";

const fail = (code: Diagnostic["code"], message: string, conflict?: Diagnostic["conflict"]) =>
  new DiagnosticError(runtimeDiagnostic({ code, severity: "error", path: "store", message, ...(conflict ? { conflict } : {}) }));

const WRITES = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);
const writes = (v: unknown): boolean =>
  Array.isArray(v) ? v.some(writes) : !!v && typeof v === "object" && Object.entries(v).some(([k, x]) => WRITES.has(k) || writes(x));

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

  /**
   * The printed form of an IR, once. A sealed plan's compiled statements (and the paged forms Core caches) are the same objects on
   * every request, and `typed` + `print` is a pure function of the IR and this executor's schemas, so the WeakMap lives as long as the plan.
   */
  private readonly printed = new WeakMap<object, { text: string; returns: boolean }>();
  /** ASTs already checked to hold no write; Core allowlists a View to one SELECT, this guards the executor on its own. */
  private readonly readChecked = new WeakSet<object>();

  private print(ir: StoreStatement["ir"]): { text: string; returns: boolean } {
    let hit = this.printed.get(ir);
    if (!hit) {
      const ast = typed(ir, this.schemas);
      this.printed.set(ir, (hit = { text: print(ast), returns: Boolean(ast[Object.keys(ast)[0]!]?.returningClause) }));
    }
    return hit;
  }

  private prepared(s: StoreStatement, i = -1): PgStatement {
    if (s.binds.length > this.maxBindings) throw fail("INPUT_VALIDATION_FAILED", `a statement binds ${s.binds.length} values; the limit is ${this.maxBindings}`);
    const printed = s.printed ? { text: s.printed.sql, returns: s.printed.returns } : undefined;
    if (s.expect === undefined) return { text: (printed ?? this.print(s.ir)).text, values: s.binds };
    // printed into the SQL, so only a whole number; any other never matched a count, so it fails as a mismatch always did
    if (!Number.isSafeInteger(s.expect)) throw fail("CONFLICT", `CONFLICT op=${i}: the write matched a different number of rows than it expected`, { opIndex: i, reason: "expect" });
    // the count is checked by the statement itself, so nothing waits on it between statements: a data-modifying CTE always
    // runs to completion, and an aggregate without GROUP BY is one group even over no rows, so the guard always runs
    const { text: inner, returns } = printed ?? this.print(s.ir);
    const text = `WITH _mantle_w AS (${inner}${returns ? "" : " RETURNING 1"}), _mantle_x AS (INSERT INTO _mantle_assert (ok) SELECT true FROM _mantle_w HAVING NOT _mantle_expect(count(*), ${s.expect})) SELECT * FROM _mantle_w`;
    return { text, values: s.binds, ...(returns ? {} : { discardRows: true }) };
  }

  async select(statement: StoreStatement): Promise<readonly StoreRow[]> {
    // a read is a bare statement now, no READ ONLY transaction behind the allowlist: one that writes is refused here too
    // a printed statement is a View the dialect checked at generate (ADR-0044); its `ir` is not built
    if (!statement.printed && !this.readChecked.has(statement.ir)) {
      if (writes(statement.ir)) throw fail("INPUT_VALIDATION_FAILED", "SQL_WRITE: a read cannot write");
      this.readChecked.add(statement.ir);
    }
    const s = this.prepared(statement);
    return (await query(this.connect, s).catch((e) => this.mapped(e, "select"))).rows;
  }

  async apply(batch: readonly StoreStatement[]): Promise<readonly StoreApplied[]> {
    const statements = batch.map((s, i) => this.prepared(s, i));
    const out = await transaction(this.connect, statements, this.timeoutMs).catch((e) => this.mapped(e, "apply"));
    return out.map((o, i) => ({ affected: o.count, rows: (statements[i] as { discardRows?: boolean }).discardRows ? [] : o.rows }));
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
      case EXPECT_STATE: throw fail("CONFLICT", `CONFLICT op=${at}: the write matched a different number of rows than it expected`, { opIndex: at ?? -1, reason: "expect" });
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
