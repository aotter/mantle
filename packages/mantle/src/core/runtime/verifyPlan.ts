/**
 * `verifyPlan`: everything boot checks about an uploaded plan, plus every program through the storage's dialect, without a
 * database or the handlers (ADR-0034 decision 7: Cloud validates the IR and never parses SQL). Worker-safe: no SQL parser.
 */
import { DiagnosticError, type Diagnostic } from "../../spec/kernel/index.js";
import type { RuntimePlan, SqlNode } from "../../spec/domain/index.js";
import { compileProgram, type Mode } from "../sql/compile.js";
import type { MantleStorageAdapter } from "../service.js";
import { createMantleRuntime } from "./createRuntime.js";

const BOOTED = Symbol("booted");

/**
 * The plan's diagnostics, empty when it would boot on `storage` and every View and inline Procedure passes the dialect's check
 * (with the storage's `restrict`) and the policy rewrite. Only `storage.dialect` is read: nothing is prepared or converged.
 * Handlers are not checked (the host binds them); enabled schedule Triggers are allowed (the host decides whether it wires them).
 */
export async function verifyPlan(plan: RuntimePlan, storage: Pick<MantleStorageAdapter, "dialect">): Promise<readonly Diagnostic[]> {
  const refs = Object.values(plan.procedures).flatMap((p) => ("ref" in p.handler ? [p.handler.ref] : []));
  try {
    // boot's own checks, stopped where storage would be prepared
    await createMantleRuntime({ plan, handlers: Object.fromEntries(refs.map((r) => [r, () => undefined])), schedules: true, storage: { dialect: storage.dialect, prepare: () => Promise.reject(BOOTED) } });
  } catch (e) {
    if (e !== BOOTED) {
      if (e instanceof DiagnosticError) return e.diagnostics;
      throw e;
    }
  }
  const out: Diagnostic[] = [];
  const check = (stmts: readonly SqlNode[], inputs: Readonly<Record<string, string>>, kind: "view" | "procedure", mode: Mode) => {
    try {
      compileProgram(stmts, { dialect: storage.dialect, schemas: plan.schemas, inputs, kind, mode });
    } catch (e) {
      if (!(e instanceof DiagnosticError)) throw e;
      out.push(...e.diagnostics);
    }
  };
  for (const [name, v] of Object.entries(plan.views)) {
    const before = out.length;
    check(v.stmts, v.inputs, "view", v.surface === "public" ? "public" : "caller");
    for (let i = before; i < out.length; i++) out[i] = { ...out[i]!, path: `plan#/views/${name}` };
  }
  for (const [name, p] of Object.entries(plan.procedures)) {
    if (!("sql" in p.handler)) continue;
    const before = out.length;
    check(p.handler.sql.stmts, p.inputs, "procedure", "caller");
    for (let i = before; i < out.length; i++) out[i] = { ...out[i]!, path: `plan#/procedures/${name}` };
  }
  return out;
}
