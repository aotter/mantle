/** Request-only host contract validation. */
export { draining } from "./drain.js";
import { forwarded, ContractError, type Caller, type Gateway, type RequestContext } from "./contracts.js";
import { surfaceError, surfaceFailure } from "./surface-failure.js";
import { userCaller } from "./user-caller.js";
import type { UserFields, UserValue } from "./user-fields.js";
import { identities, isHostCaller } from "./caller-identity.js";

/** The complete JSON supplied as ctx.props.mantle by a trusted gateway. */
export interface HostProps {
  readonly v: 1;
  readonly tenant: string;
  readonly layer: "admin" | "member";
  readonly user: Readonly<Record<string, UserValue>> & { readonly id: string; readonly role?: string };
  readonly authenticatedAs: "snapshot" | "fresh";
  readonly credential: "session" | "oauth";
  readonly requestId: string;
  /** Forwarded target pinning. */
  readonly target?: string;
  readonly targetHash?: string;
  readonly dryRun?: boolean;
  /** Step-up the host has already verified for this request (see {@link StepUp}); Core only validates its shape. */
  readonly stepUp?: StepUp;
}
/**
 * A step-up the trusted host verified before forwarding: an authentication context class, when it happened
 * (seconds since the epoch), and the nonce the application issued for it. A Procedure compares `nonce` with the
 * challenge it stored for `caller.subject`; Core never verifies identity-provider tokens.
 */
export interface StepUp { readonly acr: string; readonly auth_time: number; readonly nonce?: string }
/** `stepUp` is only on this type: read it from a Caller with {@link stepUpOf}, which checks the host brand. */
export type HostCaller = Extract<Caller, { kind: "user" | "host" }> & {
  readonly authenticatedAs: HostProps["authenticatedAs"];
  readonly credential: HostProps["credential"];
  readonly requestId: string;
  readonly stepUp?: StepUp;
};
const hostContract = (message: string, field?: string): never => { throw new ContractError("HOST_CONTRACT", message, "", { status: 412, fields: field ? { field } : undefined }); };
/** Validate the forwarding contract and reuse the ordinary user validation and brand. */
export function hostCaller(props: unknown, options: { readonly tenant: string; readonly fields?: UserFields }): HostCaller {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && !v.includes("\0") && (v as string & { isWellFormed(): boolean }).isWellFormed();
  if (!record(props)) return hostContract("Expected host contract v1.");
  const keys = "v tenant layer user authenticatedAs credential requestId target targetHash dryRun stepUp".split(" ");
  if (Object.keys(props).some(key => !keys.includes(key)) || props.v !== 1 || !text(props.tenant) || props.tenant !== options.tenant || !["admin", "member"].includes(props.layer as string) || !["snapshot", "fresh"].includes(props.authenticatedAs as string) || !["session", "oauth"].includes(props.credential as string) || !text(props.requestId) || !record(props.user)) return hostContract("Malformed host contract or tenant mismatch.");
  for (const key of ["target", "targetHash"]) if (Object.hasOwn(props, key) && !text(props[key])) return hostContract(`Invalid '${key}'.`, key);
  if (Object.hasOwn(props, "dryRun") && typeof props.dryRun !== "boolean") return hostContract("Invalid 'dryRun'.", "dryRun");
  const step = props.stepUp as Record<string, unknown> | undefined;
  if (Object.hasOwn(props, "stepUp") && !(record(step) && Object.keys(step).every(key => ["acr", "auth_time", "nonce"].includes(key)) && text(step.acr) && Number.isSafeInteger(step.auth_time) && (step.auth_time as number) >= 0 && (!Object.hasOwn(step, "nonce") || text(step.nonce)))) return hostContract("Invalid 'stepUp'.", "stepUp");
  for (const key of ["target", "targetHash"]) if (props.layer === "admin" && !text(props[key])) return hostContract(`Admin callers require '${key}'.`, key);
  const user = props.user;
  if (!text(user.id)) return hostContract("Invalid user id.", "id");
  let base: ReturnType<typeof userCaller>;
  try { base = userCaller(user as HostProps["user"], { fields: options.fields, adminRoles: [], credential: props.credential as "session" | "oauth" }); }
  catch (error) { return hostContract((error as Error).message); }
  const caller = Object.freeze({ ...base, kind: props.layer === "admin" ? "host" as const : "user" as const, subject: props.layer === "admin" ? "host:" + base.subject : base.subject, admin: props.layer === "admin", authenticatedAs: props.authenticatedAs as "snapshot" | "fresh", credential: props.credential as "session" | "oauth", requestId: props.requestId as string, target: props.target as string | undefined, targetHash: props.targetHash as string | undefined, dryRun: props.dryRun === true, ...(step !== undefined ? { stepUp: Object.freeze({ acr: step.acr as string, auth_time: step.auth_time as number, ...(Object.hasOwn(step, "nonce") ? { nonce: step.nonce as string } : {}) }) } : {}) });
  identities.set(caller, Object.freeze({ ...identities.get(base)!, admin: caller.admin, host: true }));
  return caller;
}

/** Resolve only forwarded props, or trip on an entry that did not opt in. */
export function gatewayCaller(ctx: RequestContext | undefined, gateway: Gateway | undefined, fields?: UserFields): Caller {
  const present = forwarded(ctx);
  if (!gateway) throw new ContractError('HOST_CONTRACT', 'Host props require gateway mode.', '', { status: 412 });
  if (!present) return { kind: 'anonymous' };
  return hostCaller((ctx!.props as { mantle: unknown }).mantle, { tenant: gateway.tenant, fields });
}
/** Host errors are machine-readable and never challenge for application credentials. */
export function hostFailure(error: unknown, caller?: Caller, where?: string, challenge?: string): Response {
  if ((!caller || !isHostCaller(caller)) && !(error instanceof ContractError && error.code === 'HOST_CONTRACT')) return surfaceFailure(error, challenge, where);
  const result = surfaceError(error, where);
  const code = result.status === 401 ? 'AUTH_DENIED' : result.error.code;
  return Response.json({ error: { code, ...(typeof result.error.field === 'string' ? { field: result.error.field } : {}), ...(result.error.path ? { target: result.error.path } : {}), ...(code === 'APPROVAL_REQUIRED' && typeof result.error.url === 'string' ? { url: result.error.url } : {}) } }, { status: result.status === 401 ? 403 : result.status, headers: { 'cache-control': 'private, no-store' } });
}

/** The verified step-up of a branded host caller; anything else has none, whatever its fields say. */
export function stepUpOf(caller: Caller): StepUp | undefined {
  return isHostCaller(caller) ? (caller as HostCaller).stepUp : undefined;
}

export { isHostCaller } from "./caller-identity.js";
export { checkFresh } from "./caller-mode.js";
