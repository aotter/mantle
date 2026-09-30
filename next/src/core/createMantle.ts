/**
 * `createMantle`: the one host-neutral entry (ADR-0032 decision 6). It boots the runtime lazily from `storage(env)`,
 * hands it to `service.fetch`, and turns a schedule or a deferred-hook message into an Invocation. The host's own entry
 * is one to three generated lines; Core absorbs no platform event types.
 */
import { DiagnosticError, makeDiagnostic } from "../spec/kernel/index.js";
import type { RuntimePlan } from "../spec/domain/index.js";
import { systemCaller } from "./caller.js";
import type { Invocation } from "./invocation.js";
import { createMantleRuntime } from "./runtime/createRuntime.js";
import type { MantleRuntime, MantleService, MantleStorageAdapter } from "./service.js";

interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export interface MantleOptions<Env> {
  /** The sealed plan the CLI compiled (`mantle generate` emits it beside `src/service.ts`). ADR-0032 decision 6 leaves it out of the signature. */
  readonly plan: RuntimePlan;
  readonly storage: (env: Env) => MantleStorageAdapter;
  /** Set when the entry wires schedules; boot fails for an enabled schedule Trigger without it. */
  readonly schedules?: boolean;
  /** Refuses to boot when the plan is not the one Cloud compiled. */
  readonly expectedFingerprint?: string;
}

export interface Mantle<Env> {
  fetch(request: Request, env: Env, ctx?: WaitUntil): Promise<Response>;
  invokeSchedule(cron: string, scheduledTime: number, env: Env, ctx?: WaitUntil): Promise<void>;
  runDeferredHook(message: unknown, env: Env, ctx?: WaitUntil): Promise<void>;
}

const bad = (message: string) => new DiagnosticError(makeDiagnostic({ code: "INPUT_VALIDATION_FAILED", phase: "runtime", severity: "error", path: "deferred-hook", message }));

export function createMantle<Env>(service: MantleService<Env>, options: MantleOptions<Env>): Mantle<Env> {
  let booted: Promise<MantleRuntime> | undefined;
  // a request's waitUntil outlives it only through the isolate, so the latest one is the one hooks use
  let waitUntil: (p: Promise<unknown>) => void = () => undefined;

  const runtimeFor = (env: Env, ctx?: WaitUntil) => {
    if (ctx) waitUntil = (p) => ctx.waitUntil(p);
    booted ??= createMantleRuntime({
      plan: options.plan, handlers: service.handlers as never, storage: options.storage(env), env, schedules: options.schedules,
      expectedFingerprint: options.expectedFingerprint, waitUntil: (p) => waitUntil(p),
    }).catch((e) => { booted = undefined; throw e; }); // a failed boot is retried by the next request
    return booted;
  };

  return {
    async fetch(request, env, ctx) {
      const runtime = await runtimeFor(env, ctx);
      return service.fetch(request, env, { runtime, waitUntil: (p) => waitUntil(p) });
    },

    async invokeSchedule(cron, scheduledTime, env, ctx) {
      const runtime = await runtimeFor(env, ctx);
      const errors: unknown[] = [];
      for (const [trigger, t] of Object.entries(options.plan.triggers).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (t.source.kind !== "schedule" || t.source.cron !== cron || t.source.enabled === false) continue;
        try {
          // retries keep the same cause id, so a handler can deduplicate one delivery
          await runtime.invokeProcedure({ procedure: t.procedure, input: {}, caller: systemCaller("schedule"), cause: { kind: "schedule", id: `${trigger}:${scheduledTime}`, trigger, cron, scheduledTime } });
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length) throw new AggregateError(errors, `${errors.length} scheduled Procedure(s) failed for '${cron}'`);
    },

    async runDeferredHook(message, env, ctx) {
      const inv = message as Partial<Invocation> | null;
      if (!inv || typeof inv.procedure !== "string" || !inv.caller || inv.cause?.kind !== "lifecycle" || !inv.cause.hook.startsWith("after_")) throw bad("a deferred hook message is the Invocation of an after hook");
      // the queue is Mantle's own channel, but the message is only ever honoured for what a Trigger of the plan would have run:
      // that Trigger, its Procedure and its hook, and never as the system caller (no wire produces one)
      const t = options.plan.triggers[inv.cause.trigger];
      if (inv.caller.kind === "system" || t?.source.kind !== "lifecycle" || t.procedure !== inv.procedure || t.source.schema !== inv.cause.schema || !t.source.on.includes(inv.cause.hook))
        throw bad("the message does not match a lifecycle Trigger of the plan");
      await (await runtimeFor(env, ctx)).invokeProcedure(inv as Invocation);
    },
  };
}
