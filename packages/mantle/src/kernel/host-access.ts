/** Request-only gateway decisions and observation; no database or compiler dependencies. */
import { ContractError, deny, isAdmin, isUser, wire, type AccessEvent, type AccessTarget, type Caller, type GatewayOptions, type RequestContext } from "./contracts.js";
import { valueFor, isHostCaller, checkFresh } from "./caller-identity.js";
import { isAllValues } from "./user-caller.js";
import { bytes } from "./json-body.js";

const logged = new WeakSet<NonNullable<GatewayOptions["onAccess"]>>();
export function accessRequest(ctx: RequestContext | undefined, options: GatewayOptions) {
  const present = !!ctx?.props && Object.hasOwn(ctx.props, "mantle");
  const props = (ctx?.props as { mantle?: Record<string, unknown> } | undefined)?.mantle;
  let caller: Caller | undefined, id = "", meta: AccessTarget | undefined, terms: AccessEvent["terms"] = [], finished: AccessEvent | undefined;
  let targets: Promise<Readonly<Record<string, AccessTarget>>> | undefined;
  const fail = (code: string, status: number, field?: string): never => { throw new ContractError(code, code, id, { status, fields: field ? { field } : undefined }); };
  const resolve = (policy: AccessTarget) => {
    terms = (["scope", "restrict"] as const).flatMap(via => Object.entries(policy[via]).flatMap(([schema, p]) => [
      ...(p.owner ? [{ schema, field: "id", via, values: caller && "subject" in caller ? [caller.subject] : [] }] : []),
      ...p.terms.map(t => { const v = caller ? valueFor(caller, t.field) : undefined; return { schema, field: t.field, via, values: isAllValues(v) ? "all" as const : v === undefined ? [] : Array.isArray(v) ? v : [v as string | number] }; }),
    ]));
  };
  return {
    get dryRun() { return !!caller && isHostCaller(caller) && "dryRun" in caller && caller.dryRun === true; },
    async select(target: string, resolved?: Caller, variant?: string) {
      id = target; caller = resolved;
      const all = await (targets ??= options.accessTargets?.());
      meta = all && Object.hasOwn(all, id) ? all[id] : undefined;
      terms = [];
      const policy = variant ? meta?.variants?.find(v => v.id === variant) ?? meta : meta;
      if (policy) resolve(policy);
      return policy;
    },
    async check(request: Request, readOnly: boolean, limit = 1_000_000, variant?: string) {
      if (!caller || !isHostCaller(caller)) return;
      const c = caller as Extract<Caller, { kind: "user" | "host" }>;
      if (c.target !== undefined && c.target !== id) fail("TARGET_MISMATCH", 412);
      if (c.targetHash !== undefined && (!meta || c.targetHash !== meta.targetHash)) fail("TARGET_HASH_MISMATCH", 412);
      if (!readOnly && c.target && !c.bodyDigest) fail("HOST_CONTRACT", 412, "bodyDigest");
      if (c.bodyDigest) {
        const raw = ["GET", "HEAD"].includes(request.method) ? new Uint8Array(0) : await bytes(request, limit, () => fail("INPUT_VALIDATION_FAILED", 400));
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw as Uint8Array<ArrayBuffer>));
        const encoded = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        if (c.bodyDigest !== encoded) fail("BODY_DIGEST_MISMATCH", 400);
      }
      checkFresh(caller, readOnly, id);
      const policy = variant ? meta?.variants?.find(v => v.id === variant) ?? meta : meta;
      if (policy) {
        if (this.dryRun && (policy.opaque || policy.requires.guard)) fail("DRY_RUN_UNSUPPORTED", 412);
        if (!policy.hostCallable) fail("AUTH_DENIED", 403);
        for (const p of policy.requires.all) deny(caller, typeof p === "string" ? p === "ctx.admin" ? isAdmin(caller) : isUser(caller) : c.kind === "user" && c.scopes.includes(p["ctx.auth.scope"]), id);
        for (const term of terms) {
          if (term.via === "restrict" && term.values === "all") fail("AUTH_DENIED", 403, term.field);
          if (term.values.length === 0) fail("HOST_CONTRACT", 412, term.field);
        }
      } else if (this.dryRun) fail("DRY_RUN_UNSUPPORTED", 412);
    },
    finish(error?: unknown, rowCount?: number): AccessEvent {
      if (finished) return finished;
      const failure = error === undefined ? undefined : wire(error);
      finished = { v: 1, requestId: caller && "requestId" in caller ? caller.requestId ?? "" : typeof props?.requestId === "string" ? props.requestId : "", target: id, targetHash: meta?.targetHash ?? "",
        caller: { kind: caller?.kind ?? (props?.layer === "member" ? "user" : "host"), subject: caller && "subject" in caller ? caller.subject : typeof props?.user === "object" && props.user && typeof (props.user as Record<string, unknown>).id === "string" ? (props.layer === "admin" ? "host:" : "") + (props.user as Record<string, unknown>).id : "", layer: caller && isHostCaller(caller) ? caller.kind === "host" ? "admin" : "member" : props?.layer === "member" ? "member" : "admin" },
        outcome: failure ? [401, 403].includes(failure.status) ? "deny" : "error" : "allow", ...(failure ? { reason: failure.status === 401 ? "AUTH_DENIED" : failure.error.code, ...(typeof failure.error.field === "string" ? { field: failure.error.field } : {}) } : {}), terms, ...(rowCount === undefined ? {} : { rowCount }), dryRun: caller && isHostCaller(caller) ? this.dryRun : props?.dryRun === true };
      finished = Object.freeze({...finished, caller: Object.freeze(finished.caller), terms: Object.freeze(finished.terms.map(t => Object.freeze({...t, values: t.values === "all" ? "all" : Object.freeze([...t.values])})))});
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
