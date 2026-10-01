/**
 * `createMantleRuntime`: boots one sealed plan into a running runtime (ADR-0032 decisions 3, 7 and 10).
 * Boot checks the plan, the handlers and the storage; `invokeProcedure` is the one path every source runs through.
 */
import { DiagnosticError, makeDiagnostic, readJsonPointer, type Diagnostic, type DiagnosticCode } from "../../spec/kernel/index.js";
import { RUNTIME_PLAN_VERSION, SqlRefusal, firstZodIssueAsJsonPointer, jsonSchemaToZod, planFingerprint, type LifecycleHook, type RuntimePlan } from "../../spec/domain/index.js";
import type { ZodType } from "zod";
import { systemCaller } from "../caller.js";
import { MAX_INVOCATION_DEPTH, type HandlerContext, type Invocation, type InvocationCause, type LifecycleDispatcher, type LifecycleEvent, type MantleHandlers } from "../invocation.js";
import { sqlInput } from "../sql/compile.js";
import { runProcedure, type LifecycleHooks, type RunEnv } from "../sql/run.js";
import { bindFor, createStore } from "../store/createStore.js";
import type { CallerStore } from "../store.js";
import type { MantleBootReport, MantleRuntime, MantleStorageAdapter } from "../service.js";
import { evaluateAuthAll } from "./auth.js";

export const CORE_VERSION = "0.2.0";

/** A staff View's `uiSchema.list.searchFields` and `filterFields`, which Store's `search` and `filters` match (ADR-0032 decision 5). */
function listFields(uiSchema: Readonly<Record<string, unknown>> | undefined): { searchFields?: string[]; filterFields?: string[] } {
  const list = (uiSchema?.["list"] ?? {}) as { searchFields?: string[]; filterFields?: string[] };
  return { ...(list.searchFields?.length ? { searchFields: list.searchFields } : {}), ...(list.filterFields?.length ? { filterFields: list.filterFields } : {}) };
}

export interface MantleRuntimeArgs {
  readonly plan: RuntimePlan;
  readonly handlers: MantleHandlers<never>;
  readonly storage: MantleStorageAdapter;
  /** Refuses to boot on a mismatch (`PLAN_FINGERPRINT_MISMATCH`): what Cloud compiled is what runs. */
  readonly expectedFingerprint?: string;
  /** Boot fails for any enabled schedule unless the entry wires schedules. */
  readonly schedules?: boolean;
  /** Handed to handlers as `ctx.env`. */
  readonly env?: unknown;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  /** Microseconds since the epoch, and new entry ids. */
  readonly now?: () => number;
  readonly newId?: () => string;
}

const fail = (code: DiagnosticCode, path: string, message: string, phase: Diagnostic["phase"] = "boot", extra: Partial<Diagnostic> = {}) =>
  new DiagnosticError(makeDiagnostic({ code, phase, severity: "error", path, message, ...extra }));

const VERB = { create: "insert", update: "update", delete: "delete", publish: "publish" } as const;
const depthOf = (c: InvocationCause | undefined): number => (c ? 1 + depthOf(c.parent) : 0);
const child = (parent: InvocationCause, procedure: string): InvocationCause => ({ kind: "internal", id: `${parent.id}>${procedure}`, parent });

export async function createMantleRuntime(args: MantleRuntimeArgs): Promise<MantleRuntime> {
  const { plan } = args;
  const at = "plan";

  // ---- boot: the plan is what was sealed, and what was expected ---------------------------------------------------------
  if (plan.version !== RUNTIME_PLAN_VERSION) throw fail("PLAN_FINGERPRINT_MISMATCH", at, `plan version ${plan.version} is not the version this Core runs (${RUNTIME_PLAN_VERSION})`);
  const { fingerprint, ...body } = plan;
  if ((await planFingerprint(body)) !== fingerprint) throw fail("PLAN_FINGERPRINT_MISMATCH", at, "the plan does not match its fingerprint: it changed after it was sealed");
  if (args.expectedFingerprint !== undefined && args.expectedFingerprint !== fingerprint)
    throw fail("PLAN_FINGERPRINT_MISMATCH", at, `the plan's fingerprint is ${fingerprint}, expected ${args.expectedFingerprint}`);

  // handlers and plan agree in both directions
  const refs = new Set(Object.values(plan.procedures).flatMap((p) => ("ref" in p.handler ? [p.handler.ref] : [])));
  for (const ref of refs) if (!Object.hasOwn(args.handlers, ref)) throw fail("HANDLER_NOT_REGISTERED", `${at}#/handler/${ref}`, `the plan names handler '${ref}' and none is registered`, "boot", { candidates: Object.keys(args.handlers) });
  for (const name of Object.keys(args.handlers)) if (!refs.has(name)) throw fail("HANDLER_NOT_DECLARED", `${at}#/handlers/${name}`, `handler '${name}' is registered and no Procedure of the plan declares it`);

  const triggers = Object.entries(plan.triggers).sort(([a], [b]) => (a < b ? -1 : 1));
  if (!args.schedules && triggers.some(([, t]) => t.source.kind === "schedule" && t.source.enabled !== false))
    throw fail("SCHEDULE_NOT_WIRED", at, "the plan has an enabled schedule Trigger and this entry does not wire schedules (pass schedules: true)");

  // hook targets and guards are consumer code: an inline program would write inside a before hook or a guard, which fails open
  const inline = (name: string) => !("ref" in (plan.procedures[name]?.handler ?? { ref: "" }));
  for (const [name, t] of triggers)
    if (t.source.kind === "lifecycle" && inline(t.procedure)) throw fail("LIFECYCLE_TARGET_NOT_REF", `${at}#/triggers/${name}`, `lifecycle Trigger '${name}' targets '${t.procedure}', which is an inline program`);
  for (const [name, p] of Object.entries(plan.procedures)) {
    const g = p.requires?.guard?.procedure;
    if (g && inline(g)) throw fail("GUARD_PROCEDURE_NOT_REF", `${at}#/procedures/${name}`, `'${name}' is guarded by '${g}', which is an inline program`);
  }
  for (const [name, v] of Object.entries(plan.views)) {
    const g = v.requires?.guard?.procedure;
    if (g && inline(g)) throw fail("GUARD_PROCEDURE_NOT_REF", `${at}#/views/${name}`, `View '${name}' is guarded by '${g}', which is an inline program`);
  }

  // a plan is dialect-specific: checked before storage converges to it
  const { dialect } = args.storage;
  if (plan.dialect?.name !== dialect.name || plan.dialect.version !== dialect.version)
    throw fail("PLAN_FINGERPRINT_MISMATCH", at, `the plan was compiled for dialect ${plan.dialect?.name}@${plan.dialect?.version}; this storage runs ${dialect.name}@${dialect.version}`);
  const { executor, site } = await args.storage.prepare(plan);

  // ---- lifecycle: Store hands mutations to this dispatcher; Procedures are only reached through invokeProcedure ---------------
  const byHook = new Map<string, [string, string][]>();
  const before = new Set<string>();
  const after = new Set<string>();
  for (const [name, t] of triggers) {
    if (t.source.kind !== "lifecycle") continue;
    for (const hook of t.source.on) {
      const [stage, op] = hook.split("_") as ["before" | "after", keyof typeof VERB];
      (stage === "before" ? before : after).add(`${t.source.schema}.${VERB[op]}`);
      const key = `${t.source.schema}|${hook}`;
      byHook.set(key, [...(byHook.get(key) ?? []), [name, t.procedure]]);
    }
  }
  const fire = (e: LifecycleEvent, [trigger, procedure]: [string, string]) =>
    invoke({ procedure, input: {}, caller: e.caller, cause: { kind: "lifecycle", id: `${e.id}:${trigger}`, ...(e.parent ? { parent: e.parent } : {}), trigger, hook: e.hook as LifecycleHook, schema: e.schema, rows: e.rows } });
  const dispatcher: LifecycleDispatcher = {
    // a before hook that throws rejects the mutation: it fails closed
    async before(events) {
      for (const e of events) for (const t of byHook.get(`${e.schema}|${e.hook}`) ?? []) await fire(e, t);
    },
    // an after hook never changes a committed result; the cause id is stable so a handler can deduplicate a replay
    async after(events) {
      for (const e of events)
        for (const t of byHook.get(`${e.schema}|${e.hook}`) ?? []) {
          try { await fire(e, t); } catch (error) { console.error("[mantle lifecycle] after hook failed", { trigger: t[0], hook: e.hook, schema: e.schema, error }); }
        }
    },
  };
  const lifecycle: LifecycleHooks | undefined = before.size || after.size ? { dispatcher, before, after } : undefined;

  const now = args.now ?? (() => Date.now() * 1000);
  const store = createStore({
    executor, dialect, schemas: plan.schemas, lifecycle, now,
    newId: args.newId ?? (() => crypto.randomUUID().replaceAll("-", "")),
    views: Object.fromEntries(Object.entries(plan.views).map(([name, v]) => [name, { ir: v.stmts, inputs: v.inputs, ...(v.input ? { input: v.input } : {}), ...(v.columns ? { columns: v.columns } : {}), public: v.surface === "public", ...(v.requires ? { requires: v.requires } : {}), ...(v.requires?.guard ? { guard: v.requires.guard.procedure } : {}), ...listFields(v.uiSchema) }])),
    guardView: async (procedure, caller, input, cause) => { await invoke({ procedure, input, caller, cause: child(cause, procedure) }, true); },
  });

  // ---- invocation ---------------------------------------------------------------------------------------------------------------
  const zod = new Map<string, ZodType>();
  const schemaOf = (key: string, schema: Parameters<typeof jsonSchemaToZod>[0]) => zod.get(key) ?? (zod.set(key, jsonSchemaToZod(schema)), zod.get(key)!);
  const check = (kind: "input" | "output", name: string, path: string, value: unknown, schema: Parameters<typeof jsonSchemaToZod>[0]) => {
    const r = schemaOf(`${name}#${kind}`, schema).safeParse(value);
    if (r.success) return r.data;
    const { instancePath, message } = firstZodIssueAsJsonPointer(r.error);
    throw new DiagnosticError(makeDiagnostic({
      code: kind === "input" ? "INPUT_VALIDATION_FAILED" : "OUTPUT_VALIDATION_FAILED", phase: "runtime", severity: "error", path: `${path}#/${kind}${instancePath}`,
      // an output value is handler data the schema did not expect: it may hold what the schema meant to exclude, so it never reaches a wire
      ...(kind === "input" ? { value: readJsonPointer(value, instancePath) } : {}), expected: message,
      ...(kind === "output" ? { message: `Procedure '${name}' returned a value that does not match its declared output schema. This is a handler bug.` } : {}),
    }));
  };
  const readOnly = (s: CallerStore): CallerStore => ({
    ...s, write: () => Promise.reject(fail("AUTH_DENIED", "store", "a guard or a before hook may not write", "runtime")),
  });

  async function invoke(inv: Invocation, guard = false): Promise<unknown> {
    if (depthOf(inv.cause) > MAX_INVOCATION_DEPTH)
      throw fail("INVOCATION_DEPTH_EXCEEDED", `manifest:Procedure/${inv.procedure}`, `Procedures invoked more than ${MAX_INVOCATION_DEPTH} deep (hooks and ctx.invoke count)`, "runtime");
    const proc = plan.procedures[inv.procedure];
    const path = `manifest:Procedure/${inv.procedure}`;
    if (!proc) throw fail("PROCEDURE_NOT_FOUND", path, `unknown Procedure '${inv.procedure}'`, "runtime");
    const denial = evaluateAuthAll(proc.requires, inv.caller, path);
    if (denial) throw new DiagnosticError(denial);
    const input = check("input", inv.procedure, path, inv.input, proc.input);

    // a dynamic guard sees the validated input and the same caller, reads only, and may not itself be guarded
    const guardName = proc.requires?.guard?.procedure;
    if (guardName && !guard) await invoke({ procedure: guardName, input, caller: inv.caller, cause: child(inv.cause, guardName) }, true);

    const isBefore = inv.cause.kind === "lifecycle" && inv.cause.hook.startsWith("before_");
    const ro = guard || isBefore;
    if (ro && "sql" in proc.handler) throw fail("LIFECYCLE_TARGET_NOT_REF", path, "a guard or a before hook may not be an inline program", "runtime");
    let result: unknown;
    try {
      if ("ref" in proc.handler) {
        const scoped = store.as(inv.caller, inv.cause); // writes chain to this invocation, so hooks they fire count toward the depth limit
        const ctx: HandlerContext = {
          caller: inv.caller, cause: inv.cause, env: args.env, waitUntil: args.waitUntil ?? (() => undefined),
          store: ro ? readOnly(scoped) : scoped,
          invoke: (procedure, i) => (ro ? Promise.reject(fail("AUTH_DENIED", path, "a guard or a before hook may not invoke a Procedure", "runtime")) : invoke({ procedure, input: i, caller: inv.caller, cause: child(inv.cause, procedure) })),
        };
        result = await (args.handlers[proc.handler.ref] as (i: unknown, c: HandlerContext) => unknown)(input, ctx);
      } else {
        const { mode, bind } = bindFor(now(), inv.caller);
        const env: RunEnv = { executor, dialect, schemas: plan.schemas, mode, lifecycle };
        const ran = await runProcedure(env, { kind: "procedure", inputs: proc.inputs, ir: proc.handler.sql.stmts }, { caller: inv.caller, cause: inv.cause, bind: { ...bind, input: sqlInput(proc.input, input) } });
        result = { results: ran.rows };
      }
    } catch (e) {
      if (e instanceof DiagnosticError) throw e;
      if (e instanceof SqlRefusal) throw fail("INPUT_VALIDATION_FAILED", path, e.message, "runtime");
      console.error(`[mantle procedure ${inv.procedure}] unhandled failure`, e);
      throw fail("INTERNAL_ERROR", path, "An internal error occurred.", "runtime");
    }
    return check("output", inv.procedure, path, result, proc.output);
  }

  return {
    plan,
    store,
    invokeProcedure: (invocation) => invoke(invocation),
    bootReport: (): MantleBootReport => ({ fingerprint, coreVersion: CORE_VERSION }),
    ...(site ? { site } : {}),
  };
}

export { systemCaller };
