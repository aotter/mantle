/** Build-time dialect checks, policy lowering and SQL printing. */
import type { SqlContext, SqlDiagnostic, SqlNode, SqlPlan, SqlSchemaDef } from "../spec/domain/index.js";
import type { PolicyLowering } from "./sql/policy.js";

/** A Schema as storage and the policy rewriter read it from the plan. */
export interface StorageSchema extends SqlSchemaDef {
  /** Boolean expressions over the row's own columns (IR), enforced by the engine on every write. */
  readonly checks?: readonly SqlNode[];
  /** Fields `search` matches. */
  readonly search?: readonly string[];
  /** Unique constraints; on a scoped Schema the scope column is added. */
  readonly unique?: readonly (readonly string[])[];
  /** Ordered composite non-unique indexes. */
  readonly indexes?: readonly (readonly string[])[];
}

/** Core's policy rewriter adds visibility and ownership to every relation position; the dialect spells the rest (`lowering`). */
export interface MantleDialect {
  /** What a plan compiled for this dialect records (`RuntimePlan.dialect`); boot refuses any other. */
  readonly name: string;
  readonly version: string;
  /** The dialect's refusals of a program's IR. Run on every program: the runtime never trusts an IR. */
  check(plan: SqlPlan, context: SqlContext): readonly SqlDiagnostic[];
  readonly lowering: PolicyLowering;
  /**
   * The engine orders as PostgreSQL does (ADR-0039): NULL sorts as the largest value, and the appended `id` tiebreak runs in the
   * direction of the last sort key, so a btree index serves ORDER BY ... LIMIT. Absent, the SQLite rule applies: NULL first
   * ascending, last descending, `id` ascending.
   */
  readonly nativeOrder?: boolean;
  /**
   * The engine's SQL is its own (ADR-0039), not SQLite's vocabulary lowered onto it: `json_each`, `->> '$.path'`, integer
   * truthiness and `||` over non-text are refused or mean what the engine says. The compliance suite then runs the engine's
   * spelling of those cases.
   */
  readonly nativeSql?: boolean;
  /**
   * The dialect's printer: the very function its executor prints with (ADR-0044 decision 3). `mantle generate` prints every View and
   * inline Procedure through it. Absent, a plan for this dialect carries no lowered statements.
   */
  print?(ast: SqlNode, schemas: Readonly<Record<string, StorageSchema>>): string;
  /** What else the printed text depends on (PostgreSQL: the time zone); compared with `plan.lowered.dialect.key`. */
  readonly lowerKey?: string;
  /** Set by `restricted()`: an operator's refusals run on every program, so lowered statements are never used (ADR-0044 decision 5). */
  readonly restricted?: boolean;
}
