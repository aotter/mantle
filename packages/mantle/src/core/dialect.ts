/**
 * The runtime side of a SQL dialect as Core uses it (ADR-0035 decisions 3 and 6). Core holds no engine code: the storage
 * adapter hands Core its dialect, and Store checks, rewrites, binds and decodes through it. Internal until the compliance
 * suite makes it a public interface (ADR-0035, How to apply 5); the D1 dialect is the one implementation.
 */
import type { SqlContext, SqlDiagnostic, SqlNode, SqlPlan, SqlSchemaDef } from "../spec/domain/index.js";
import type { BindContext } from "./sql/compile.js";
import type { DialectBind, PolicyLowering } from "./sql/policy.js";

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

/** The Store's wire values to and from what the engine stores (ADR-0034 decision 5). A value the type cannot hold throws `SqlRefusal`. */
export interface StoreCodec {
  encode(type: string, value: unknown): unknown;
  decode(type: string, value: unknown): unknown;
}

/** An operator's own refusals of a program's IR, run after the dialect's at runtime (ADR-0037 decision 4). It can only narrow. An accepted program's verdict is cached per program (Core's compile cache), so `restrict` must be a pure function of (plan, context); refusals are not cached. */
export type RestrictSql = (plan: SqlPlan, context: SqlContext) => readonly SqlDiagnostic[];

/** The dialect with `restrict` run after its own check. */
export function restricted(dialect: MantleDialect, restrict?: RestrictSql): MantleDialect {
  if (!restrict) return dialect;
  return { ...dialect, check: (plan, context) => { const own = dialect.check(plan, context); return own.length ? own : restrict(plan, context); } };
}

/** Core's policy rewriter adds visibility and ownership to every relation position; the dialect spells the rest (`lowering`). */
export interface MantleDialect {
  /** What a plan compiled for this dialect records (`RuntimePlan.dialect`); boot refuses any other. */
  readonly name: string;
  readonly version: string;
  readonly codec: StoreCodec;
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
  /** Resolves a bind the lowering added. */
  bind(spec: DialectBind, context: BindContext): unknown;
}
