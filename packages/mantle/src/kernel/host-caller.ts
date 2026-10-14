/** Request-only host contract validation. */
import { ContractError, surfaceError, surfaceFailure, type Caller, type Gateway, type RequestContext } from "./contracts.js";
import { userCaller, validUserFieldName, valueOf } from "./user-caller.js";
import type { UserFields, UserValue } from "./user-fields.js";
import { identities, isHostCaller } from "./caller-identity.js";

/** The complete JSON supplied as ctx.props.mantle by a trusted gateway. */
export interface HostProps {
  readonly v: 1;
  readonly tenant: string;
  readonly layer: "admin" | "member";
  readonly user: Readonly<Record<string, UserValue>> & { readonly id: string; readonly role?: string; readonly email?: string; readonly name?: string };
  readonly authenticatedAs: "snapshot" | "fresh";
  readonly credential: "session" | "oauth";
  readonly requestId: string;
  /** Reserved controls: v1 refuses these keys until supported. */
  readonly target?: string;
  readonly targetHash?: string;
  readonly bodyDigest?: string;
  readonly dryRun?: true;
}
export type HostCaller = Extract<Caller, { kind: "user" | "host" }> & {
  readonly authenticatedAs: HostProps["authenticatedAs"];
  readonly credential: HostProps["credential"];
  readonly requestId: string;
};
const hostContract = (message: string, field?: string): never => { throw new ContractError("HOST_CONTRACT", message, "", { status: 412, fields: field ? { field } : undefined }); };
/** Validate the forwarding contract and reuse the ordinary user validation and brand. */
export function hostCaller(props: unknown, options: { readonly tenant: string; readonly fields?: UserFields }): HostCaller {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && !v.includes("\0") && (v as string & { isWellFormed(): boolean }).isWellFormed();
  if (!record(props)) return hostContract("Expected host contract v1.");
  const keys = "v tenant layer user authenticatedAs credential requestId target targetHash bodyDigest dryRun".split(" ");
  if (Object.keys(props).some(key => !keys.includes(key)) || props.v !== 1 || !text(props.tenant) || props.tenant !== options.tenant || !["admin", "member"].includes(props.layer as string) || !["snapshot", "fresh"].includes(props.authenticatedAs as string) || !["session", "oauth"].includes(props.credential as string) || !text(props.requestId) || !record(props.user)) return hostContract("Malformed host contract or tenant mismatch.");
  for (const key of ["dryRun", "target", "targetHash", "bodyDigest"]) if (Object.hasOwn(props, key)) return hostContract(`Reserved field '${key}' is not supported in v1.`, key);
  const user = props.user;
  if (!text(user.id)) return hostContract("Invalid user id.", "id");
  for (const key of ["role", "email", "name"]) if (Object.hasOwn(user, key) && typeof user[key] !== "string") return hostContract(`Invalid user '${key}'.`, key);
  // Validate even unused values at the trust boundary; only declared fields retain authority.
  for (const [field, value] of Object.entries(user)) {
    if (["id", "role", "email", "name"].includes(field)) continue;
    if (value == null || !validUserFieldName(field)) return hostContract(`Invalid user field '${field}'.`, field);
    try { valueOf(value, (options.fields && Object.hasOwn(options.fields, field) ? options.fields[field] : undefined) ?? { type: typeof (Array.isArray(value) ? value[0] : value) === "number" ? "number" : "string", multiple: true }, field); }
    catch (error) { return hostContract((error as Error).message, field); }
  }
  let base: ReturnType<typeof userCaller>;
  try { base = userCaller(user as HostProps["user"], { fields: options.fields, adminRoles: [], credential: props.credential as "session" | "oauth" }); }
  catch (error) { return hostContract((error as Error).message); }
  const caller = Object.freeze({ ...base, kind: props.layer === "admin" ? "host" as const : "user" as const, subject: props.layer === "admin" ? "host:" + base.subject : base.subject, admin: props.layer === "admin", authenticatedAs: props.authenticatedAs as "snapshot" | "fresh", credential: props.credential as "session" | "oauth", requestId: props.requestId as string });
  identities.set(caller, Object.freeze({ ...identities.get(base)!, admin: caller.admin, host: true }));
  return caller;
}

/** Resolve only forwarded props, or trip on an entry that did not opt in. */
export function gatewayCaller(ctx: RequestContext | undefined, gateway: Gateway | undefined, fields?: UserFields): Caller {
  const present = !!ctx?.props && Object.hasOwn(ctx.props, 'mantle');
  if (!gateway) throw new ContractError('HOST_CONTRACT', 'Host props require gateway mode.', '', { status: 412 });
  if (!present) return { kind: 'anonymous' };
  return hostCaller((ctx!.props as { mantle: unknown }).mantle, { tenant: gateway.tenant, fields });
}
/** Host errors are machine-readable and never challenge for application credentials. */
export function hostFailure(error: unknown, caller?: Caller, where?: string): Response {
  if ((!caller || !isHostCaller(caller)) && !(error instanceof ContractError && error.code === 'HOST_CONTRACT')) return surfaceFailure(error, undefined, where);
  const result = surfaceError(error, where);
  const code = result.status === 401 ? 'AUTH_DENIED' : result.error.code;
  return Response.json({ error: { code, ...(typeof result.error.field === 'string' ? { field: result.error.field } : {}), ...(result.error.path ? { target: result.error.path } : {}) } }, { status: result.status === 401 ? 403 : result.status, headers: { 'cache-control': 'private, no-store' } });
}

export { isHostCaller } from "./caller-identity.js";
export { checkFresh } from "./caller-identity.js";
