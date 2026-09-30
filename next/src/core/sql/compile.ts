/**
 * IR -> physical statements: validate (the runtime never trusts an IR), inject policy, resolve binds.
 * Everything a Store does per statement before the executor runs it (ADR-0034 decisions 3 and 8).
 */
import { PG_GRAMMAR, validateIr, type SqlNode, type SqlPlan } from "../../spec/index.js";
import { runtimeDiagnostic, DiagnosticError } from "../../spec/index.js";
import { encodeInput } from "./codec.js";
import { applyPolicy, type Arg, type BindSpec, type Compiled, type Mode, type PolicyOpts } from "./policy.js";
import type { RelationPosition } from "./positions.js";
import type { StorageSchema } from "./storage.js";

export type { Compiled, Mode } from "./policy.js";

/** Who and when a statement runs for; `input` is the Procedure or View input. */
export interface BindContext {
  /** The caller's subject; null for an anonymous caller, who matches no scoped row. */
  readonly uid: string | null;
  readonly now: number;
  readonly role?: string | null;
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface CompileContext {
  readonly schemas: Readonly<Record<string, StorageSchema>>;
  /** Declared input properties and their Mantle types. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly kind: "view" | "procedure";
  readonly mode?: Mode;
  /** Schemas with an after hook: their writes return `id` and `version` in hidden columns. */
  readonly returning?: ReadonlySet<string>;
  /** Add `AND version = ?` (the version the before hook saw) to a row op. */
  readonly lockVersion?: boolean;
  /** Per statement: the status an update moves the entry to (Store's `set: { status }`). */
  readonly statuses?: readonly (string | undefined)[];
  /** Records every relation position the policy printed a wrapper for (the position probe checks it is complete). */
  readonly seen?: Set<RelationPosition>;
  /** NEGATIVE CONTROL ONLY (see RunEnv). */
  readonly unsafeNoVisibility?: boolean;
}

/** Validate every statement of a program, then inject policy. A refused IR is `INPUT_VALIDATION_FAILED`. */
export function compileProgram(stmts: readonly SqlNode[], ctx: CompileContext): Compiled[] {
  const diagnostics = validateIr({ grammar: PG_GRAMMAR, stmts } satisfies SqlPlan, { schemas: ctx.schemas, inputs: ctx.inputs, kind: ctx.kind, public: ctx.mode === "public" });
  if (diagnostics.length)
    throw new DiagnosticError(diagnostics.map((d) => runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message: `${d.code}: ${d.message}` })));
  const opts: PolicyOpts = { schemas: ctx.schemas, inputs: ctx.inputs, mode: ctx.mode, lockVersion: ctx.lockVersion, returning: ctx.returning as Set<string> | undefined, seen: ctx.seen, unsafeNoVisibility: ctx.unsafeNoVisibility };
  return stmts.map((stmt, i) => {
    const c = applyPolicy(stmt, { ...opts, status: ctx.statuses?.[i] });
    // a Schema whose published entries are protected takes row ops only (ADR-0032 decision 2, ADR-0034 decision 4)
    if (c.kind === "set" && c.schema && ctx.schemas[c.schema]?.publishing)
      throw new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message: `SQL_SHAPE: a set op on ${c.schema} is refused: its lifecycle is publishing, so published entries are protected and writes take row ops only` }));
    return c;
  });
}

/** The box a near() query binds to the R*Tree: a bounding box of the radius, padded for float32 storage. */
function box(which: "minLat" | "maxLat" | "minLng" | "maxLng", lat: number, lng: number, meters: number): number {
  const dLat = meters / 111_320;
  const dLng = meters / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 1e-9));
  const pad = 1e-4;
  if (Math.abs(lat) + dLat >= 90 || Math.abs(lng) + dLng >= 180)
    throw new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message: "near(): a box that crosses the antimeridian or a pole is refused" }));
  return { minLat: lat - dLat - pad, maxLat: lat + dLat + pad, minLng: lng - dLng - pad, maxLng: lng + dLng + pad }[which];
}

/** Resolve a statement's numbered binds. `version` and `cursor` values come from the caller of this function. */
export function bindValues(binds: readonly BindSpec[], ctx: BindContext, extra: { version?: unknown; cursor?: readonly unknown[] } = {}): unknown[] {
  const input = ctx.input ?? {};
  const arg = (a: Arg) => ("const" in a ? a.const : Number(input[a.input]));
  return binds.map((b) => {
    switch (b.k) {
      case "uid": return ctx.uid;
      case "now": return ctx.now;
      case "cutoff": return ctx.now - b.seconds * 1_000_000;
      case "const": return b.value;
      case "role": return ctx.role ?? null;
      case "input": return encodeInput(b.type, input[b.name]);
      case "version": return extra.version;
      case "cursor": return extra.cursor![b.i];
      case "box": return box(b.which, arg(b.lat), arg(b.lng), b.meters);
    }
  });
}
