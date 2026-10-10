/**
 * `createMantleRuntime`: boots one sealed plan into a running runtime (ADR-0032 decisions 3, 7 and 10).
 * Boot checks the plan, the handlers and the storage; `invokeProcedure` is the one path every source runs through.
 */
import { DiagnosticError, makeDiagnostic, readJsonPointer, type Diagnostic, type DiagnosticCode } from "../../spec/kernel/index.js";
import { RUNTIME_PLAN_VERSION, SqlRefusal, firstZodIssueAsJsonPointer, jsonSchemaToZod, planFingerprint, safeParseJson, type LifecycleHook, type RuntimePlan, type TriggerManifest, ManifestParseError } from "../../spec/domain/index.js";
import { validateTriggerSpec } from "../../spec/domain/service/TriggerSpecChecks.js";
import type { ZodType } from "zod";
import { systemCaller } from "../caller.js";
import { MAX_INVOCATION_DEPTH, type HandlerContext, type Invocation, type InvocationCause, type LifecycleDispatcher, type LifecycleEvent, type MantleHandlers } from "../invocation.js";
import { sqlInput } from "../sql/compile.js";
import { runProcedure, type LifecycleHooks, type RunEnv } from "../sql/run.js";
import { bindFor, createStore } from "../store/createStore.js";
import type { CallerStore } from "../store.js";
import type { MantleBootReport, MantleRuntime, MantleStorageAdapter } from "../service.js";
import { evaluateAuthAll } from "./auth.js";
import { lifecycleHookSets, lifecycleKey } from "./hooks.js";
import { loweringStatus, seedPlan } from "../sql/lowered.js";

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
  readonly waitUntil?: (promise: Promise<unknown>, cause?: InvocationCause) => void;
  /** Microseconds since the epoch, and new entry ids. */
  readonly now?: () => number;
  readonly newId?: () => string;
}

const fail = (code: DiagnosticCode, path: string, message: string, phase: Diagnostic["phase"] = "boot", extra: Partial<Diagnostic> = {}) =>
  new DiagnosticError(makeDiagnostic({ code, phase, severity: "error", path, message, ...extra }));

const depthOf = (c: InvocationCause | undefined): number => {
  let depth = 0;
  for (; c && depth <= MAX_INVOCATION_DEPTH; c = c.parent) depth++;
  return depth;
};
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
  // a Trigger is checked as the CLI checks its manifest (a lifecycle hook that is not one would bind nothing), and it targets a
  // Procedure and a Schema of this plan: a surface that cannot find one fails on every request instead
  for (const [name, t] of triggers) {
    const path = `${at}#/triggers/${name}`;
    try {
      validateTriggerSpec({ spec: { source: t.source, target: { procedure: t.procedure } } } as unknown as TriggerManifest, undefined as unknown as number); // no document index: the path names the Trigger
    } catch (e) {
      if (e instanceof ManifestParseError) throw fail(e.code, `${path}${e.pointer?.replace(/^\/spec/, "") ?? ""}`, e.message);
      throw e;
    }
    if (!Object.hasOwn(plan.procedures, t.procedure)) throw fail("TRIGGER_TARGET_PROCEDURE_UNKNOWN", path, `Trigger '${name}' targets '${t.procedure}', which is not a Procedure of the plan`);
    // the dispatcher keys hooks by the Schema's key (its name in lower case) and a deferred after hook is honoured only for the
    // Schema's name as declared (`runDeferredHook`), so the Trigger names a Schema exactly as the CLI's linker requires
    const key = t.source.kind === "lifecycle" ? lifecycleKey(plan, t.source.schema) : undefined;
    if (t.source.kind === "lifecycle" && (key === undefined || plan.schemas[key]!.name !== t.source.schema))
      throw fail("LIFECYCLE_SCHEMA_UNKNOWN", path, `lifecycle Trigger '${name}' watches '${t.source.schema}', which is not the name of a Schema of the plan`);
  }
  if (!args.schedules && triggers.some(([, t]) => t.source.kind === "schedule" && t.source.enabled !== false))
    throw fail("SCHEDULE_NOT_WIRED", at, "the plan has an enabled schedule Trigger and this entry does not wire schedules (pass schedules: true)");

  // Lifecycle targets receive their event through a ref handler; guards are ref handlers with a read-only context.
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
    throw fail("PLAN_FINGERPRINT_MISMATCH", at, `the plan was compiled for dialect ${plan.dialect?.name}@${plan.dialect?.version}; this storage runs ${dialect.name}@${dialect.version}; regenerate the plan (\`mantle generate\`)`);
  const { executor, site } = await args.storage.prepare(plan);

  // ---- lifecycle: Store hands mutations to this dispatcher; Procedures are only reached through invokeProcedure ---------------
  const { before, after, byHook } = lifecycleHookSets(plan);
  const fire = (e: LifecycleEvent, [trigger, procedure]: [string, string]) =>
    invoke({ procedure, input: {}, caller: e.caller, cause: { kind: "lifecycle", id: `${e.id}:${trigger}`, ...(e.parent ? { parent: e.parent } : {}), trigger, hook: e.hook as LifecycleHook, schema: plan.schemas[e.schema]?.name ?? e.schema, rows: e.rows } });
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

  // ---- lowered statements: seeded into the compile cache, or ignored and said so (ADR-0044) ---------------------------------------
  const loweredStatus = loweringStatus(plan, dialect);
  if (loweredStatus === "used") seedPlan(plan, dialect, lifecycle?.after);
  else if (plan.lowered && loweredStatus !== "restricted") console.warn(`[mantle boot] lowered statements not used (${loweredStatus}); regenerate the plan with this Mantle (\`mantle generate\`)`);

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
    const r = safeParseJson(schemaOf(`${name}#${kind}`, schema), value);
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
    ...s, write: () => Promise.reject(fail("AUTH_DENIED", "store", "a guard may not write", "runtime")),
  });

  async function invoke(inv: Invocation, guard = false): Promise<unknown> {
    if (depthOf(inv.cause) > MAX_INVOCATION_DEPTH)
      throw fail("INVOCATION_DEPTH_EXCEEDED", `manifest:Procedure/${inv.procedure}`, `Procedures invoked more than ${MAX_INVOCATION_DEPTH} deep (hooks and ctx.invoke count)`, "runtime");
    const proc = Object.hasOwn(plan.procedures, inv.procedure) ? plan.procedures[inv.procedure] : undefined;
    const path = `manifest:Procedure/${inv.procedure}`;
    if (!proc) throw fail("PROCEDURE_NOT_FOUND", path, `unknown Procedure '${inv.procedure}'`, "runtime");
    const denial = evaluateAuthAll(proc.requires, inv.caller, path);
    if (denial) throw new DiagnosticError(denial);
    const input = check("input", inv.procedure, path, inv.input, proc.input);

    // a dynamic guard sees the validated input and the same caller, reads only, and may not itself be guarded
    const guardName = proc.requires?.guard?.procedure;
    if (guardName && !guard) await invoke({ procedure: guardName, input, caller: inv.caller, cause: child(inv.cause, guardName) }, true);

    if (guard && "sql" in proc.handler) throw fail("GUARD_PROCEDURE_NOT_REF", path, "a guard may not be an inline program", "runtime");
    let result: unknown;
    try {
      if ("ref" in proc.handler) {
        const bound = store.as(inv.caller, inv.cause); // writes chain to this invocation, so hooks they fire count toward the depth limit
        // only the system caller reaches TTL maintenance: no request can produce one (ADR-0032 decision 8)
        const scoped = inv.caller.kind === "system" && !guard ? { ...bound, sweepExpired: store.sweepExpired } : bound;
        const ctx: HandlerContext = {
          caller: inv.caller, cause: inv.cause, env: args.env, waitUntil: (promise) => args.waitUntil?.(promise, inv.cause),
          store: guard ? readOnly(scoped) : scoped,
          invoke: (procedure, i) => (guard ? Promise.reject(fail("AUTH_DENIED", path, "a guard may not invoke a Procedure", "runtime")) : invoke({ procedure, input: i, caller: inv.caller, cause: child(inv.cause, procedure) })),
        };
        result = await (args.handlers[proc.handler.ref] as (i: unknown, c: HandlerContext) => unknown)(input, ctx);
      } else {
        const { mode, bind } = bindFor(now(), inv.caller);
        const env: RunEnv = { executor, dialect, schemas: plan.schemas, mode, lifecycle };
        const ran = await runProcedure(env, { kind: "procedure", inputs: proc.inputs, ir: proc.handler.sql.stmts }, { caller: inv.caller, cause: inv.cause, bind: { ...bind, input: sqlInput(proc.input, input) } }, true);
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
    bootReport: (): MantleBootReport => ({ fingerprint, coreVersion: CORE_VERSION, lowered: loweredStatus }),
    ...(site ? { site } : {}),
  };
}

export { systemCaller };
