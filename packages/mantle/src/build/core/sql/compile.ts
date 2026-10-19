/**
 * IR -> physical statements: validate (the runtime never trusts an IR), inject policy, resolve binds.
 * Everything a Store does per statement before the executor runs it (ADR-0034 decisions 3 and 8).
 */
import { PG_GRAMMAR, type SchemaColumns, type SqlNode, type SqlPlan } from "../../spec/domain/index.js";
import { runtimeDiagnostic, DiagnosticError } from "../../spec/kernel/index.js";
import type { MantleDialect, StorageSchema } from "../dialect.js";
import { applyPolicy, type BindSpec, type Compiled, type Mode, type PolicyOpts } from "./policy.js";
import type { RelationPosition } from "./positions.js";

export type { Compiled, Mode } from "./policy.js";

export interface CompileContext {
  readonly restrict?: PolicyOpts['restrict'];
  readonly dialect: MantleDialect;
  readonly schemas: Readonly<Record<string, StorageSchema>>;
  /** `schemaColumns(schemas)`, when the caller checks many programs against one plan. */
  readonly columns?: SchemaColumns;
  /** Declared input properties and their Mantle types. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly kind: "view" | "procedure";
  readonly mode: Mode;
  /** Schema + semantic verb keys whose after hooks need whole rows in hidden columns. */
  readonly returning?: ReadonlySet<string>;
  /** Add `AND version = ?` (the version checked by the publishing lifecycle) to a row op. */
  readonly lockVersion?: boolean;
  /** Per statement: the status an update moves the entry to (Store's `set: { status }`). */
  readonly statuses?: readonly (string | undefined)[];
  /** Records every relation position the policy printed a wrapper for (the position probe checks it is complete). */
  readonly seen?: Set<RelationPosition>;
  /** NEGATIVE CONTROL ONLY (see RunEnv). */
  readonly unsafeNoVisibility?: boolean;
  /** Admin's generic writes print one WHERE for every field set: they add each written field's reference check themselves (adminEntries). */
  readonly uncheckedRefs?: true;
}

/** Check every statement of a program with the dialect, then inject policy. A refused IR is `INPUT_VALIDATION_FAILED`. */
export function compileProgram(stmts: readonly SqlNode[], ctx: CompileContext): Compiled[] {
  const diagnostics = ctx.dialect.check({ grammar: PG_GRAMMAR, stmts } satisfies SqlPlan, { schemas: ctx.schemas, ...(ctx.columns ? { columns: ctx.columns } : {}), inputs: ctx.inputs, kind: ctx.kind, public: ctx.mode === "public" });
  if (diagnostics.length)
    throw new DiagnosticError(diagnostics.map((d) => runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message: `${d.code}: ${d.message}` })));
  const opts: PolicyOpts = { restrict: ctx.restrict, schemas: ctx.schemas, inputs: ctx.inputs, mode: ctx.mode, lockVersion: ctx.lockVersion, returning: ctx.returning, seen: ctx.seen, unsafeNoVisibility: ctx.unsafeNoVisibility, uncheckedRefs: ctx.uncheckedRefs, lower: ctx.dialect.lowering, nativeOrder: ctx.dialect.nativeOrder };
  return stmts.map((stmt, i) => {
    const c = applyPolicy(stmt, { ...opts, status: ctx.statuses?.[i] });
    // a Schema whose published entries are protected takes row ops only (ADR-0032 decision 2, ADR-0034 decision 4)
    if (c.kind === "set" && c.schema && ctx.schemas[c.schema]?.publishing)
      throw new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message: `SQL_SHAPE: a set op on ${c.schema} is refused: its lifecycle is publishing, so published entries are protected and writes take row ops only` }));
    return c;
  });
}
