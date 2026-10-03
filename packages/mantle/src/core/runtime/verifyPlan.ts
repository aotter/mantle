/**
 * `verifyPlan`: everything boot checks about an uploaded plan, plus every program through the storage's dialect, without a
 * database or the handlers (ADR-0034 decision 7: Cloud validates the IR and never parses SQL). Worker-safe: no SQL parser.
 */
import { DiagnosticError, makeDiagnostic, type Diagnostic } from "../../spec/kernel/index.js";
import { SqlRefusal, hasSubLink, type RuntimePlan, type SqlNode } from "../../spec/domain/index.js";
import { compileProgram, type Mode } from "../sql/compile.js";
import type { MantleStorageAdapter } from "../service.js";
import { createMantleRuntime } from "./createRuntime.js";

const BOOTED = Symbol("booted");

const refused = (path: string, message: string): Diagnostic => makeDiagnostic({ code: "INPUT_VALIDATION_FAILED", phase: "boot", severity: "error", path, message });

/**
 * The plan's diagnostics: what boot refuses before storage (version, fingerprint, dialect, guard and hook targets), and every
 * Schema check, View and inline Procedure through the storage's dialect (with its `restrict`) and the policy rewrite. Empty
 * means no program can run SQL the dialect refuses. Only `storage.dialect` is read, so storage's own refusals (a reserved table
 * name, a column type it cannot store) still surface where the plan first boots against its database, as with any plan.
 * Handlers are not checked (the host binds them); enabled schedule Triggers are allowed (the host decides whether it wires them).
 */
export async function verifyPlan(plan: RuntimePlan, storage: Pick<MantleStorageAdapter, "dialect">): Promise<readonly Diagnostic[]> {
  // the plan is untrusted input: a shape Core does not expect is a refusal, never an exception
  try {
    return await verify(plan, storage);
  } catch (e) {
    if (e instanceof DiagnosticError) return e.diagnostics;
    return [makeDiagnostic({ code: "INVALID_MANIFEST_ENVELOPE", phase: "boot", severity: "error", path: "plan", message: `the plan is malformed: ${e instanceof Error ? e.message : String(e)}` })];
  }
}

async function verify(plan: RuntimePlan, storage: Pick<MantleStorageAdapter, "dialect">): Promise<readonly Diagnostic[]> {
  const refs = Object.values(plan.procedures).flatMap((p) => ("ref" in p.handler ? [p.handler.ref] : []));
  try {
    // boot's own checks, stopped where storage would be prepared
    await createMantleRuntime({ plan, handlers: Object.fromEntries(refs.map((r) => [r, () => undefined])), schedules: true, storage: { dialect: storage.dialect, prepare: () => Promise.reject(BOOTED) } });
  } catch (e) {
    if (e !== BOOTED) throw e;
  }
  const out: Diagnostic[] = [...schemaNames(plan)];
  const check = (path: string, stmts: readonly SqlNode[], inputs: Readonly<Record<string, string>>, kind: "view" | "procedure", mode: Mode) => {
    try {
      compileProgram(stmts, { dialect: storage.dialect, schemas: plan.schemas, inputs, kind, mode });
    } catch (e) {
      // the dialect's refusals arrive as a DiagnosticError, the policy rewrite's as a SqlRefusal; the runtime refuses both
      if (e instanceof DiagnosticError) out.push(...e.diagnostics.map((d) => ({ ...d, path })));
      else if (e instanceof SqlRefusal) out.push(refused(path, `${e.code}: ${e.message}`));
      else throw e;
    }
  };
  // a check is printed into the table's DDL and runs on every write: checked as the CLI compiles it, the WHERE of a read of its own Schema
  for (const [name, schema] of Object.entries(plan.schemas))
    for (const [i, where] of (schema.checks ?? []).entries()) {
      const path = `plan#/schemas/${name}/checks/${i}`;
      if (hasSubLink(where)) out.push(refused(path, "SQL_SHAPE: a check reads only the row's own columns: no subquery"));
      else check(path, [{ SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }], fromClause: [{ RangeVar: { relname: name.toLowerCase(), inh: true, relpersistence: "p", mantle: "table" } }], whereClause: where, limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }], {}, "view", "caller");
    }
  for (const [name, v] of Object.entries(plan.views)) check(`plan#/views/${name}`, v.stmts, v.inputs, "view", v.surface === "public" ? "public" : "caller");
  for (const [name, p] of Object.entries(plan.procedures)) if ("sql" in p.handler) check(`plan#/procedures/${name}`, p.handler.sql.stmts, p.inputs, "procedure", "caller");
  return out;
}

const NATIVE = new Set(["id", "version", "status", "author_id", "created_at", "updated_at"]);
const TYPE = /^(text|integer|real|bool|json|timestamptz|date|geo|numeric\(\d+, ?\d+\))$/;

/**
 * A Schema's names as the CLI writes them: its key, fields, scope, ttl, search, unique and index columns lower case, and each one
 * a declared field (or a native column). SQL folds names, the checks compare folded names and storage quotes them, so a plan whose
 * `Items` and `items`, or scope `Owner` and field `owner`, are two things to one layer and one to another is refused here.
 */
function schemaNames(plan: RuntimePlan): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [key, s] of Object.entries(plan.schemas)) {
    const bad = (what: string) => out.push(refused(`plan#/schemas/${key}`, `SQL_SHAPE: ${what}`));
    const fields = s.fields ?? {};
    const isName = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x === x.toLowerCase();
    const known = (x: unknown) => isName(x) && (Object.hasOwn(fields, x) || NATIVE.has(x));
    if (!isName(key) || typeof s.name !== "string" || s.name.toLowerCase() !== key) bad("a Schema's key is its name in lower case");
    for (const [f, t] of Object.entries(fields)) if (!isName(f) || NATIVE.has(f) || typeof t !== "string" || !TYPE.test(t)) bad(`field ${JSON.stringify(f)} is a lower-case name with a Mantle type`);
    for (const [f, n] of Object.entries(s.names ?? {})) if (!Object.hasOwn(fields, f) || typeof n !== "string" || n.toLowerCase() !== f) bad(`names[${JSON.stringify(f)}] names a field`);
    if (s.scope !== undefined && !(isName(s.scope) && Object.hasOwn(fields, s.scope))) bad("scope is a declared field");
    if (s.ttl !== undefined && !known(s.ttl)) bad("ttl is a declared field");
    for (const cols of [...(s.search ? [s.search] : []), ...(s.unique ?? []), ...(s.indexes ?? [])]) if (!Array.isArray(cols) || !cols.length || !cols.every(known)) bad("search, unique and index columns are declared fields");
  }
  return out;
}
