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

/** Core's policy rewriter adds visibility and ownership to every relation position; the dialect spells the rest (`lowering`). */
export interface MantleDialect {
  readonly codec: StoreCodec;
  /** The dialect's refusals of a program's IR. Run on every program: the runtime never trusts an IR. */
  check(plan: SqlPlan, context: SqlContext): readonly SqlDiagnostic[];
  readonly lowering: PolicyLowering;
  /** Resolves a bind the lowering added. */
  bind(spec: DialectBind, context: BindContext): unknown;
}
