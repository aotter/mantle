/** Request-only gateway decisions and observation; no database or compiler dependencies. */
import { forwarded, ContractError, wire, type AccessEvent, type AccessTarget, type Caller, type GatewayOptions, type RequestContext } from "./contracts.js";
import { isHostCaller, checkFresh } from "./caller-identity.js";

const logged = new WeakSet<NonNullable<GatewayOptions["onAccess"]>>();
export function accessRequest(ctx: RequestContext | undefined, options: GatewayOptions) {
  const present = forwarded(ctx);
  const props = (ctx?.props as { mantle?: Record<string, unknown> } | undefined)?.mantle;
  let caller: Caller | undefined, id = "", meta: AccessTarget | undefined, finished: AccessEvent | undefined;
  let targets: Promise<Readonly<Record<string, AccessTarget>>> | undefined;
  const fail = (code: string, status: number, field?: string): never => { throw new ContractError(code, code, id, { status, fields: field ? { field } : undefined }); };
  return {
    get dryRun() { return !!caller && isHostCaller(caller) && "dryRun" in caller && caller.dryRun === true; },
    async select(target: string, resolved?: Caller) {
      id = target; caller = resolved;
      const all = await (targets ??= options.accessTargets?.());
      meta = all && Object.hasOwn(all, id) ? all[id] : undefined;
    },
    async check(readOnly: boolean, variant?: string) {
      if (!caller || !isHostCaller(caller)) return;
      const c = caller as Extract<Caller, { kind: "user" | "host" }>;
      if (c.target !== undefined && c.target !== id) fail("TARGET_MISMATCH", 412);
      if (c.targetHash !== undefined && (!meta || c.targetHash !== meta.targetHash)) fail("TARGET_HASH_MISMATCH", 412);
      checkFresh(caller, readOnly, id);
      const policy = variant ? meta?.variants?.find(v => v.id === variant) ?? meta : meta;
      if (this.dryRun && (!policy || policy.opaque || policy.guard)) fail("DRY_RUN_UNSUPPORTED", 412);
    },
    finish(error?: unknown): AccessEvent {
      if (finished) return finished;
      const failure = error === undefined ? undefined : wire(error);
      finished = { v: 1, requestId: caller && "requestId" in caller ? caller.requestId ?? "" : typeof props?.requestId === "string" ? props.requestId : "", target: id, targetHash: meta?.targetHash ?? "",
        caller: { kind: caller?.kind ?? (props?.layer === "member" ? "user" : "host"), subject: caller && "subject" in caller ? caller.subject : typeof props?.user === "object" && props.user && typeof (props.user as Record<string, unknown>).id === "string" ? (props.layer === "admin" ? "host:" : "") + (props.user as Record<string, unknown>).id : "", layer: caller && isHostCaller(caller) ? caller.kind === "host" ? "admin" : "member" : props?.layer === "member" ? "member" : "admin" },
        outcome: failure ? [401, 403].includes(failure.status) ? "deny" : "error" : "allow", ...(failure ? { reason: failure.status === 401 ? "AUTH_DENIED" : failure.error.code, ...(typeof failure.error.field === "string" ? { field: failure.error.field } : {}) } : {}), dryRun: caller && isHostCaller(caller) ? this.dryRun : props?.dryRun === true };
      finished = Object.freeze({...finished, caller: Object.freeze(finished.caller)});
      if (present && options.onAccess) {
        const listener = options.onAccess;
        const log = () => { if (!logged.has(listener)) { logged.add(listener); console.error("[mantle onAccess] listener failed"); } };
        // Schedule observation after the decision without awaiting its promise.
        queueMicrotask(() => { try { void Promise.resolve(listener(finished!)).catch(log); } catch { log(); } });
      }
      return finished;
    },
    async finishResponse(response: Response) {
      if (response.status < 400) return this.finish();
      const payload = await response.clone().json().catch(() => null) as {error?: {code?: unknown; field?: string}} | null;
      const code = typeof payload?.error?.code === "string" ? payload.error.code : [401,403].includes(response.status) ? "AUTH_DENIED" : response.status < 500 ? "INPUT_VALIDATION_FAILED" : "INTERNAL_ERROR";
      return this.finish(new ContractError(code, "", id, {status:response.status, fields:payload?.error?.field ? {field:payload.error.field} : undefined}));
    },
    response() { return Response.json({ dryRun: true, event: this.finish() }, { headers: { "cache-control": "private, no-store" } }); },
  };
}
