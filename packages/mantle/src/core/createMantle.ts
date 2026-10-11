/**
 * `createMantle`: the one host-neutral entry (ADR-0032 decision 6). It boots the runtime lazily from `storage(env)`,
 * hands it to `service.fetch`, and turns a schedule or a deferred-hook message into an Invocation. The host's own entry
 * is one to three generated lines; Core absorbs no platform event types.
 */
import { DiagnosticError, makeDiagnostic } from "../spec/kernel/index.js";
import type { RuntimePlan } from "../spec/domain/index.js";
import { STAFF_ROLES, LIFECYCLE_HOOKS } from "../spec/domain/index.js";
import { systemCaller } from "./caller.js";
import { MAX_INVOCATION_DEPTH, type Invocation, type InvocationCause } from "./invocation.js";
import { createMantleRuntime } from "./runtime/createRuntime.js";
import { bindStoreCause } from "./store/createStore.js";
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
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Queue payloads are unknown, including their caller and parent chain. Validate before boot or dispatch. */
function deferredInvocation(message: unknown): Invocation {
  if (!record(message) || typeof message.procedure !== "string" || !record(message.caller)) throw bad("invalid deferred Invocation");
  const c = message.caller;
  if (c.kind !== "anonymous" && !(c.kind === "user" && typeof c.subject === "string" && c.subject.length > 0
    && (c.role === null || (STAFF_ROLES as readonly unknown[]).includes(c.role))
    && Array.isArray(c.scopes) && c.scopes.every((s) => typeof s === "string")
    && ["session", "oauth", "api-key", "personal-token"].includes(c.credential as string)
    && (c.credentialId === null || typeof c.credentialId === "string") && (c.clientId === null || typeof c.clientId === "string"))) throw bad("invalid deferred caller");
  let cause = message.cause;
  let depth = 0;
  while (cause !== undefined) {
    if (++depth > MAX_INVOCATION_DEPTH || !record(cause) || typeof cause.id !== "string") throw bad("invalid deferred cause chain");
    if (!["http", "mcp", "internal", "schedule", "lifecycle"].includes(cause.kind as string)) throw bad("invalid deferred cause kind");
    if (cause.kind === "lifecycle" && (typeof cause.trigger !== "string" || typeof cause.schema !== "string"
      || typeof cause.hook !== "string" || !(LIFECYCLE_HOOKS as readonly string[]).includes(cause.hook)
      || !Array.isArray(cause.rows) || !cause.rows.length || !cause.rows.every(record))) throw bad("invalid deferred lifecycle cause");
    if (cause.kind === "schedule" && (typeof cause.trigger !== "string" || typeof cause.cron !== "string" || typeof cause.scheduledTime !== "number" || !Number.isFinite(cause.scheduledTime))) throw bad("invalid deferred schedule cause");
    cause = cause.parent;
  }
  if (!record(message.cause) || message.cause.kind !== "lifecycle" || !(message.cause.hook as string).startsWith("after_")) throw bad("a deferred hook message is the Invocation of an after hook");
  return message as unknown as Invocation;
}

export function createMantle<Env>(service: MantleService<Env>, options: MantleOptions<Env>): Mantle<Env> {
  let booted: Promise<MantleRuntime> | undefined;
  const retainers = new WeakMap<InvocationCause, (p: Promise<unknown>) => void>();

  const runtimeFor = async (env: Env, ctx?: WaitUntil): Promise<MantleRuntime> => {
    booted ??= createMantleRuntime({
      plan: options.plan, handlers: service.handlers as never, storage: options.storage(env), env, schedules: options.schedules,
      expectedFingerprint: options.expectedFingerprint, waitUntil: (p, cause) => {
        for (let depth = 0; cause && depth <= MAX_INVOCATION_DEPTH; cause = cause.parent, depth++) {
          const retain = retainers.get(cause);
          if (retain) { retain(p); return; }
        }
      },
    }).catch((e) => { booted = undefined; throw e; }); // a failed boot is retried by the next request
    const runtime = await booted;
    const retain = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : () => undefined;
    const hostCause: InvocationCause = { kind: "internal", id: `host:${crypto.randomUUID()}` };
    retainers.set(hostCause, retain);
    return {
      ...runtime,
      invokeProcedure: (inv) => {
        const cause = { ...inv.cause };
        retainers.set(cause, retain);
        return runtime.invokeProcedure({ ...inv, cause });
      },
      store: {
        ...runtime.store,
        ...bindStoreCause(runtime.store, hostCause),
        as: (caller, cause = { kind: "internal", id: `store:${crypto.randomUUID()}` }) => {
          const boundCause = { ...cause };
          retainers.set(boundCause, retain);
          return runtime.store.as(caller, boundCause);
        },
      },
    };
  };

  return {
    async fetch(request, env, ctx) {
      const runtime = await runtimeFor(env, ctx);
      return service.fetch(request, env, { runtime, waitUntil: ctx ? (p) => ctx.waitUntil(p) : () => undefined });
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
      const inv = deferredInvocation(message);
      // the queue is Mantle's own channel, but the message is only ever honoured for what a Trigger of the plan would have run:
      // that Trigger, its Procedure and its hook, and never as the system caller (no wire produces one)
      if (inv.cause.kind !== "lifecycle") throw bad("invalid deferred lifecycle cause");
      const t = Object.hasOwn(options.plan.triggers, inv.cause.trigger) ? options.plan.triggers[inv.cause.trigger] : undefined;
      if (inv.caller.kind === "system" || t?.source.kind !== "lifecycle" || t.procedure !== inv.procedure || t.source.schema !== inv.cause.schema || !t.source.on.includes(inv.cause.hook))
        throw bad("the message does not match a lifecycle Trigger of the plan");
      await (await runtimeFor(env, ctx)).invokeProcedure(inv as Invocation);
    },
  };
}
